// gentl-hub API: public reads, passcode-protected writes (secret PASSCODE).
// It shares two formats with gentl: the task text (served by GET /api/tasks/:id) and the run directory (uploaded).

const RUN_FORMAT = 1; // the run directory format this hub accepts

const NUMBER_COLUMNS = [
	"turns", "read_tokens_total", "notes_tokens_total", "notes_tokens_max", "result_tokens_total", "result_tokens_max",
	"overhead_tokens", "model_output_tokens", "parse_errors", "cost_usd",
] as const;

const LIST_COLUMNS = `r.id, r.task_id, t.title AS task_title, r.local_run_id, r.uploaded_by, r.uploaded_at, r.gentl_version,
	r.model, r.backend, r.sandbox, r.image, ${NUMBER_COLUMNS.map((c) => `r.${c}`).join(", ")},
	r.stop_reason, r.self_reported_success, r.verdict, r.evaluator_model`;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function error(message: string, status: number): Response {
	return json({ error: message }, status);
}

async function passcodeOk(req: Request, env: Env): Promise<boolean> {
	const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
	if (!env.PASSCODE || !given) return false;
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(given)),
		crypto.subtle.digest("SHA-256", enc.encode(env.PASSCODE)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function readJson<T>(req: Request): Promise<T | null> {
	try {
		return (await req.json()) as T;
	} catch {
		return null;
	}
}

// ---------- tasks ----------

const TASK_STATS = `SELECT t.id, t.title, t.text, t.created_by, t.created_at,
	COUNT(r.id) AS run_count,
	COALESCE(SUM(r.verdict = 1), 0) AS success_count
	FROM tasks t LEFT JOIN runs r ON r.task_id = t.id`;

async function listTasks(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(`${TASK_STATS} GROUP BY t.id ORDER BY t.id DESC`).all();
	return json(results);
}

function quantile(sorted: number[], q: number): number {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos), hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

type RunRow = { model: string; backend: string | null; verdict: number | null; read_tokens_total: number; notes_tokens_max: number; turns: number };

// Per model and backend: runs, evaluator-judged successes, and read tokens over the successful runs.
function byModel(runs: RunRow[]) {
	const groups = new Map<string, RunRow[]>();
	for (const r of runs) {
		const k = `${r.model}\u0000${r.backend ?? ""}`;
		groups.set(k, [...(groups.get(k) ?? []), r]);
	}
	return [...groups.values()].map((rs) => {
		const ok = rs.filter((r) => r.verdict === 1);
		const reads = ok.map((r) => r.read_tokens_total).sort((a, b) => a - b);
		const turns = ok.map((r) => r.turns).sort((a, b) => a - b);
		const notesMax = ok.map((r) => r.notes_tokens_max).sort((a, b) => a - b);
		return {
			model: rs[0].model, backend: rs[0].backend, runs: rs.length, successes: ok.length,
			read_median: reads.length ? quantile(reads, 0.5) : null,
			read_q1: reads.length ? quantile(reads, 0.25) : null,
			read_q3: reads.length ? quantile(reads, 0.75) : null,
			read_min: reads.length ? reads[0] : null,
			turns_median: turns.length ? quantile(turns, 0.5) : null,
			notes_max_median: notesMax.length ? quantile(notesMax, 0.5) : null,
		};
	}).sort((a, b) => b.runs - a.runs);
}

async function getTask(id: number, env: Env): Promise<Response> {
	const task = await env.DB.prepare(`${TASK_STATS} WHERE t.id = ? GROUP BY t.id`).bind(id).first();
	if (!task) return error("not found", 404);
	const { results } = await env.DB.prepare(
		`SELECT ${LIST_COLUMNS} FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.task_id = ?
		ORDER BY (r.verdict = 1) DESC, r.read_tokens_total ASC`,
	).bind(id).all<RunRow>();
	return json({ task, by_model: byModel(results), runs: results });
}

async function createTask(req: Request, env: Env): Promise<Response> {
	if (!(await passcodeOk(req, env))) return error("invalid passcode", 401);
	const body = await readJson<{ title?: unknown; text?: unknown; user?: unknown }>(req);
	if (!body) return error("invalid JSON", 400);
	const title = String(body.title ?? "").trim();
	const text = String(body.text ?? "").trim();
	const user = String(body.user ?? "").trim();
	if (!title) return error("title is required", 400);
	if (title.length > 200) return error("title is too long (max 200 chars)", 400);
	if (!text) return error("task text is required", 400);
	if (text.length > 20000) return error("task text is too long (max 20000 chars)", 400);
	if (!user) return error("user is required", 400);
	const row = await env.DB.prepare("INSERT INTO tasks (title, text, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING id")
		.bind(title, text, user, new Date().toISOString()).first<{ id: number }>();
	return json({ id: row!.id }, 201);
}

// Deletes a task together with its runs and their turns.
async function deleteTask(req: Request, id: number, env: Env): Promise<Response> {
	if (!(await passcodeOk(req, env))) return error("invalid passcode", 401);
	const task = await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(id).first();
	if (!task) return error("not found", 404);
	const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").bind(id).first<{ n: number }>();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM turns WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)").bind(id),
		env.DB.prepare("DELETE FROM runs WHERE task_id = ?").bind(id),
		env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id),
	]);
	return json({ deleted: { task: id, runs: runs?.n ?? 0 } });
}

// ---------- runs ----------

type UploadTurn = {
	turn: number;
	notes_tokens: number;
	result_tokens: number;
	notes?: string | null;
	notes_ops?: string[] | null;
	action?: unknown;
	result_shown?: string | null;
	result_full_chars?: number | null;
	parse_error?: string | null;
	raw_response?: string | null;
	notes_reminder?: boolean;
};

type Upload = {
	user: string;
	summary: Record<string, any>;
	evaluation?: Record<string, any> | null;
	final_state?: string | null;
	turns: UploadTurn[];
};

async function createRun(req: Request, env: Env): Promise<Response> {
	if (!(await passcodeOk(req, env))) return error("invalid passcode", 401);
	const body = await readJson<Upload>(req);
	if (!body) return error("invalid JSON", 400);
	const s = body.summary ?? {};
	const user = String(body.user ?? "").trim();
	if (!user) return error("user is required", 400);
	if (s.format !== RUN_FORMAT) return error(`unsupported run format ${s.format}; this hub accepts format ${RUN_FORMAT}`, 400);
	if (typeof s.run_id !== "string" || typeof s.task !== "string" || typeof s.model !== "string")
		return error("summary must include run_id, task and model", 400);
	for (const c of NUMBER_COLUMNS) if (typeof s[c] !== "number") return error(`summary.${c} must be a number`, 400);
	if (!Array.isArray(body.turns)) return error("turns must be an array", 400);
	if (s.task_source?.kind !== "hub" || typeof s.task_source.id !== "number")
		return error("only runs of tasks from a hub can be uploaded", 400);
	if (s.local_copy) return error("runs that used a local copy of the repo cannot be uploaded", 400);

	const taskId = s.task_source.id as number;
	const t = await env.DB.prepare("SELECT text FROM tasks WHERE id = ?").bind(taskId).first<{ text: string }>();
	if (!t) return error(`task ${taskId} does not exist on this hub`, 400);
	if (t.text.trim() !== s.task.trim()) return error(`the run's task text does not match task ${taskId}`, 400);

	const exists = await env.DB.prepare("SELECT id FROM runs WHERE uploaded_by = ? AND local_run_id = ?")
		.bind(user, s.run_id).first<{ id: number }>();
	if (exists) return error(`run already uploaded (id ${exists.id})`, 409);

	const ev = body.evaluation ?? null;
	const cols = ["task_id", "local_run_id", "uploaded_by", "uploaded_at", "format", "gentl_version", "model", "backend",
		"sandbox", "image", ...NUMBER_COLUMNS, "stop_reason", "self_reported_success", "verdict", "evaluator_model",
		"summary_json", "evaluation_json", "final_state"];
	const row = await env.DB.prepare(
		`INSERT INTO runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`,
	).bind(
		taskId, s.run_id, user, new Date().toISOString(), s.format, s.gentl_version ?? null, s.model, s.backend ?? null,
		s.sandbox ?? null, s.image ?? null, ...NUMBER_COLUMNS.map((c) => s[c] as number), s.stop_reason ?? null,
		s.self_reported_success == null ? null : s.self_reported_success ? 1 : 0,
		ev ? (ev.success ? 1 : 0) : null, ev?.model ?? null,
		JSON.stringify(s), ev ? JSON.stringify(ev) : null, body.final_state ?? null,
	).first<{ id: number }>();
	const id = row!.id;

	const stmt = env.DB.prepare(
		`INSERT INTO turns (run_id, turn, notes_tokens, result_tokens, notes, notes_ops, action_json, result_shown,
			result_full_chars, parse_error, raw_response, notes_reminder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const inserts = body.turns.map((t) => stmt.bind(
		id, t.turn, t.notes_tokens, t.result_tokens, t.notes ?? null, t.notes_ops ? JSON.stringify(t.notes_ops) : null,
		t.action == null ? null : JSON.stringify(t.action), t.result_shown ?? null, t.result_full_chars ?? null,
		t.parse_error ?? null, t.raw_response ?? null, t.notes_reminder ? 1 : 0,
	));
	try {
		for (let i = 0; i < inserts.length; i += 50) await env.DB.batch(inserts.slice(i, i + 50));
	} catch (e) {
		await env.DB.prepare("DELETE FROM turns WHERE run_id = ?").bind(id).run();
		await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(id).run();
		return error(`failed to store turns: ${e}`, 400);
	}
	return json({ id }, 201);
}

async function listRuns(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT ${LIST_COLUMNS} FROM runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.id DESC LIMIT 500`,
	).all();
	return json(results);
}

async function getRun(id: number, env: Env): Promise<Response> {
	const run = await env.DB.prepare(
		`SELECT ${LIST_COLUMNS}, t.text AS task_text, r.summary_json, r.evaluation_json, r.final_state
		FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`,
	).bind(id).first();
	if (!run) return error("not found", 404);
	const { results } = await env.DB.prepare("SELECT * FROM turns WHERE run_id = ? ORDER BY turn").bind(id).all();
	return json({ run, turns: results });
}

async function deleteRun(req: Request, id: number, env: Env): Promise<Response> {
	if (!(await passcodeOk(req, env))) return error("invalid passcode", 401);
	const run = await env.DB.prepare("SELECT id FROM runs WHERE id = ?").bind(id).first();
	if (!run) return error("not found", 404);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM turns WHERE run_id = ?").bind(id),
		env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(id),
	]);
	return json({ deleted: { run: id } });
}

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, "");
		if (path === "/api/tasks" && req.method === "GET") return listTasks(env);
		if (path === "/api/tasks" && req.method === "POST") return createTask(req, env);
		const mt = path.match(/^\/api\/tasks\/(\d+)$/);
		if (mt && req.method === "GET") return getTask(Number(mt[1]), env);
		if (mt && req.method === "DELETE") return deleteTask(req, Number(mt[1]), env);
		if (path === "/api/runs" && req.method === "GET") return listRuns(env);
		if (path === "/api/runs" && req.method === "POST") return createRun(req, env);
		const mr = path.match(/^\/api\/runs\/(\d+)$/);
		if (mr && req.method === "GET") return getRun(Number(mr[1]), env);
		if (mr && req.method === "DELETE") return deleteRun(req, Number(mr[1]), env);
		return error("not found", 404);
	},
} satisfies ExportedHandler<Env>;
