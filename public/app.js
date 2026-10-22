// gentl-hub frontend: tasks at "/", a task at "/tasks/<id>", all runs at "/runs", a run at "/runs/<id>".

const app = document.getElementById("app");
const tooltip = document.getElementById("tooltip");

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (x) => (x == null ? "-" : Math.round(Number(x)).toLocaleString());
const date = (iso) => esc(String(iso).slice(0, 16).replace("T", " "));
const firstLine = (s, max = 140) => {
	const line = String(s).split("\n")[0];
	return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

// Per-viewer conveniences only; the page works without storage.
const store = {
	get(k) { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
	set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function verdict(r) {
	if (r.verdict === 1) return { cls: "ok", text: "success" };
	if (r.verdict === 0) return { cls: "bad", text: "failure" };
	return { cls: "warn", text: r.stop_reason === "finish" ? "not evaluated" : `did not finish (${r.stop_reason ?? "?"})` };
}

async function getJSON(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(res.status === 404 ? "not found" : `HTTP ${res.status}`);
	return res.json();
}

function navigate(path) {
	history.pushState(null, "", path);
	route();
}

document.addEventListener("click", (e) => {
	const a = e.target.closest("a[data-nav]");
	if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
		e.preventDefault();
		navigate(a.getAttribute("href"));
	}
});
window.addEventListener("popstate", route);

function route() {
	tooltip.hidden = true;
	window.scrollTo(0, 0);
	const p = location.pathname.replace(/\/+$/, "");
	let m;
	if ((m = p.match(/^\/runs\/(\d+)$/))) return showRun(Number(m[1]));
	if ((m = p.match(/^\/tasks\/(\d+)$/))) return showTask(Number(m[1]));
	if (p === "/runs") return showAllRuns();
	return showTasks();
}

function nav(active) {
	const link = (href, label, key) => `<a href="${href}" data-nav class="${active === key ? "active" : ""}">${label}</a>`;
	return `<header class="top"><a href="/" data-nav class="brand">gentl hub</a>
		<nav>${link("/", "Tasks", "tasks")}${link("/runs", "All runs", "runs")}</nav></header>`;
}

const LEDE = `<p class="lede"><a href="https://github.com/magland/gentl">gentl</a> is a readability test for codebases. An agent with no memory beyond a few notes carries out a task the way a newcomer would (clone the repo, set it up from the docs, make a change, verify it), and gentl measures how much it had to read. An evaluator then judges the run and writes a friction report: what was missing or wrong in the docs, and where the agent guessed. Reading effort is compared only among runs judged successful, with the same model.</p>`;

// ---------- tasks ----------

async function showTasks() {
	document.title = "gentl hub";
	app.innerHTML = `${nav("tasks")}${LEDE}
		<details class="new-task"><summary>New task</summary>
			<form id="new-task">
				<label>Title<input name="title" required maxlength="200" placeholder="e.g. mochiforge: example dev server and API"></label>
				<label>Task<textarea name="text" rows="5" required placeholder="Plain text naming the repos to clone (and a tag or commit where it matters), e.g. Clone https://github.com/owner/foo, install it and run its tests."></textarea></label>
				<div class="row">
					<label>Your name<input name="user" required value="${esc(store.get("gentl-user"))}"></label>
					<label>Passcode<input name="passcode" type="password" required value="${esc(store.get("gentl-passcode"))}"></label>
					<button type="submit">Create task</button>
				</div>
				<p class="form-msg" id="new-task-msg"></p>
			</form>
		</details>
		<div class="table-wrap"><table>
			<thead><tr><th>#</th><th>Task</th><th>Created by</th><th class="num">Runs</th><th class="num">Successes</th></tr></thead>
			<tbody id="tasks"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
		</table></div>`;
	document.getElementById("new-task").addEventListener("submit", createTask);
	const tbody = document.getElementById("tasks");
	try {
		const tasks = await getJSON("/api/tasks");
		if (!tasks.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No tasks yet.</td></tr>'; return; }
		tbody.innerHTML = tasks.map((t) => `<tr class="link" data-href="/tasks/${t.id}">
			<td><a href="/tasks/${t.id}" data-nav>${t.id}</a></td>
			<td class="task"><b>${esc(t.title)}</b><div class="muted small">${esc(firstLine(t.text))}</div></td>
			<td>${esc(t.created_by)}</td>
			<td class="num">${t.run_count}</td>
			<td class="num">${t.success_count}</td>
		</tr>`).join("");
		bindRowLinks(tbody);
	} catch (e) {
		tbody.innerHTML = `<tr><td colspan="5" class="empty">Failed to load tasks: ${esc(e.message)}</td></tr>`;
	}
}

async function createTask(e) {
	e.preventDefault();
	const f = e.target;
	const msg = document.getElementById("new-task-msg");
	const user = f.user.value.trim(), passcode = f.passcode.value;
	store.set("gentl-user", user);
	store.set("gentl-passcode", passcode);
	msg.textContent = "Creating...";
	msg.className = "form-msg";
	try {
		const res = await fetch("/api/tasks", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${passcode}` },
			body: JSON.stringify({ title: f.title.value, text: f.text.value, user }),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		navigate(`/tasks/${data.id}`);
	} catch (err) {
		msg.textContent = `Could not create task: ${err.message}`;
		msg.className = "form-msg bad";
	}
}

function byModelTable(rows) {
	if (!rows.length) return "";
	const iqr = (r) => (r.read_q1 == null ? "-" : `${n(r.read_q1)}-${n(r.read_q3)}`);
	return `<div class="table-wrap"><table>
		<thead><tr><th>Model</th><th>Backend</th><th class="num">Runs</th><th class="num">Successes</th>
			<th class="num">Read tokens, median</th><th class="num">IQR</th><th class="num">Fewest</th><th class="num">Turns, median</th></tr></thead>
		<tbody>${rows.map((r) => `<tr><td class="nowrap">${esc(r.model)}</td><td>${esc(r.backend ?? "")}</td>
			<td class="num">${r.runs}</td><td class="num">${r.successes}</td>
			<td class="num"><strong>${n(r.read_median)}</strong></td><td class="num">${iqr(r)}</td>
			<td class="num">${n(r.read_min)}</td><td class="num">${n(r.turns_median)}</td></tr>`).join("")}</tbody>
	</table></div>`;
}

async function showTask(id) {
	document.title = `gentl hub: task ${id}`;
	app.innerHTML = `${nav("tasks")}<p class="muted">Loading...</p>`;
	let task, runs, by_model;
	try {
		({ task, runs, by_model } = await getJSON(`/api/tasks/${id}`));
	} catch (e) {
		app.innerHTML = `${nav("tasks")}<p class="bad">Failed to load task ${id}: ${esc(e.message)}</p>`;
		return;
	}
	document.title = `gentl hub: ${task.title}`;
	const command = `gentl run ${location.origin}/tasks/${task.id} --upload`;
	app.innerHTML = `${nav("tasks")}
		<div class="title-row"><h1>${esc(task.title)}</h1>${deleteControl("Delete task")}</div>
		<div class="meta"><span>Task <b>${task.id}</b></span><span>Created by <b>${esc(task.created_by)}</b></span><span>Created <b>${date(task.created_at)}</b></span></div>
		<p class="task-text">${esc(task.text)}</p>
		<h2>Run this task</h2>
		<p class="muted small">Needs <a href="https://github.com/magland/gentl">gentl</a> and Docker, and a model backend (an OpenRouter key in <code>OPENROUTER_API_KEY</code>, or <code>--backend claude-code</code> for a Claude Code login). gentl shows the task and asks before running it, clones the published repo, and uploads the run here when it finishes; the first upload asks for your name and the hub's passcode.</p>
		<div class="cmd"><pre id="cmd">${esc(command)}</pre><button id="copy" type="button">Copy</button></div>
		<h2>Results by model</h2>
		${by_model.length ? byModelTable(by_model) : '<p class="muted">No runs yet.</p>'}
		<h2>Runs</h2>
		${runsTable(runs, false)}`;
	document.getElementById("copy").addEventListener("click", async (e) => {
		try { await navigator.clipboard.writeText(command); e.target.textContent = "Copied"; }
		catch { e.target.textContent = "Copy failed"; }
		setTimeout(() => { e.target.textContent = "Copy"; }, 1500);
	});
	bindRowLinks(app);
	bindDelete(`/api/tasks/${task.id}`,
		`Delete task ${task.id}${task.run_count ? ` and its ${task.run_count} run${task.run_count === 1 ? "" : "s"}` : ""}? This cannot be undone.`,
		"/");
}

// ---------- delete ----------

function deleteControl(label) {
	return `<div class="delete">
		<button type="button" class="secondary" id="del-open">${label}</button>
		<div class="confirm" id="del-confirm" hidden>
			<p id="del-text"></p>
			<div class="row">
				<input type="password" id="del-pass" placeholder="Passcode" value="${esc(store.get("gentl-passcode"))}">
				<button type="button" class="danger" id="del-go">Delete</button>
				<button type="button" class="secondary" id="del-cancel">Cancel</button>
			</div>
			<p class="form-msg" id="del-msg"></p>
		</div>
	</div>`;
}

function bindDelete(apiUrl, question, afterPath) {
	const box = document.getElementById("del-confirm");
	const open = document.getElementById("del-open");
	const msg = document.getElementById("del-msg");
	document.getElementById("del-text").textContent = question;
	open.addEventListener("click", () => { box.hidden = false; open.hidden = true; document.getElementById("del-pass").focus(); });
	document.getElementById("del-cancel").addEventListener("click", () => { box.hidden = true; open.hidden = false; msg.textContent = ""; });
	document.getElementById("del-go").addEventListener("click", async () => {
		const passcode = document.getElementById("del-pass").value;
		msg.textContent = "Deleting...";
		msg.className = "form-msg";
		try {
			const res = await fetch(apiUrl, { method: "DELETE", headers: { authorization: `Bearer ${passcode}` } });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			store.set("gentl-passcode", passcode);
			navigate(afterPath);
		} catch (err) {
			msg.textContent = `Could not delete: ${err.message}`;
			msg.className = "form-msg bad";
		}
	});
}

// ---------- run lists ----------

function runsTable(runs, showTask) {
	const cols = 10 + (showTask ? 1 : 0);
	const body = !runs.length ? `<tr><td colspan="${cols}" class="empty">No runs yet.</td></tr>` : runs.map((r) => {
		const v = verdict(r);
		return `<tr class="link" data-href="/runs/${r.id}">
			<td><a href="/runs/${r.id}" data-nav>${r.id}</a></td>
			<td class="nowrap">${date(r.uploaded_at)}</td>
			<td>${esc(r.uploaded_by)}</td>
			${showTask ? `<td class="task"><a href="/tasks/${r.task_id}" data-nav>${esc(r.task_title)}</a></td>` : ""}
			<td class="nowrap">${esc(r.model)}<div class="muted small">${esc(r.backend ?? "")}${r.sandbox ? `, ${esc(r.sandbox)}` : ""}</div></td>
			<td class="nowrap"><span class="${v.cls}">${v.text}</span></td>
			<td class="num">${r.turns}</td>
			<td class="num"><strong>${n(r.read_tokens_total)}</strong></td>
			<td class="num">${n(r.notes_tokens_max)}</td>
			<td class="num">${n(r.result_tokens_max)}</td>
			<td class="num">$${Number(r.cost_usd).toFixed(4)}</td>
		</tr>`;
	}).join("");
	return `<div class="table-wrap"><table>
		<thead><tr>
			<th>#</th><th>Uploaded</th><th>By</th>${showTask ? "<th>Task</th>" : ""}<th>Model</th><th>Verdict</th>
			<th class="num">Turns</th><th class="num">Read tokens</th><th class="num">Max notes</th>
			<th class="num">Max result</th><th class="num">Cost</th>
		</tr></thead><tbody>${body}</tbody></table></div>`;
}

function bindRowLinks(root) {
	root.querySelectorAll("tr.link").forEach((tr) => tr.addEventListener("click", (e) => {
		if (!e.target.closest("a") && !getSelection().toString()) navigate(tr.dataset.href);
	}));
}

async function showAllRuns() {
	document.title = "gentl hub: all runs";
	app.innerHTML = `${nav("runs")}<p class="muted">Loading...</p>`;
	try {
		const runs = await getJSON("/api/runs");
		app.innerHTML = `${nav("runs")}${runsTable(runs, true)}`;
		bindRowLinks(app);
	} catch (e) {
		app.innerHTML = `${nav("runs")}<p class="bad">Failed to load runs: ${esc(e.message)}</p>`;
	}
}

// ---------- run viewer ----------

async function showRun(id) {
	document.title = `gentl hub: run ${id}`;
	app.innerHTML = `${nav("runs")}<p class="muted">Loading...</p>`;
	let r, turns;
	try {
		({ run: r, turns } = await getJSON(`/api/runs/${id}`));
	} catch (e) {
		app.innerHTML = `${nav("runs")}<p class="bad">Failed to load run ${id}: ${esc(e.message)}</p>`;
		return;
	}
	const s = JSON.parse(r.summary_json);
	const ev = r.evaluation_json ? JSON.parse(r.evaluation_json) : null;
	const v = verdict(r);
	app.innerHTML = `
		${nav("")}
		<div class="crumb"><a href="/tasks/${r.task_id}" data-nav>${esc(r.task_title)}</a> / run ${r.id}</div>
		<div class="title-row"><h1>Run ${r.id}</h1>${deleteControl("Delete run")}</div>
		<div class="meta">
			<span>By <b>${esc(r.uploaded_by)}</b></span>
			<span>Model <b>${esc(r.model)}</b> (${esc(r.backend ?? "?")})</span>
			<span>Sandbox <b>${esc(r.sandbox ?? "?")}</b>${r.image ? ` <code>${esc(r.image)}</code>` : ""}</span>
			<span>Uploaded <b>${date(r.uploaded_at)}</b></span>
			<span>gentl <b>${esc(r.gentl_version ?? "?")}</b></span>
			<span>Local id <b>${esc(r.local_run_id)}</b></span>
		</div>
		<p class="task-text">${esc(r.task_text)}</p>
		<div class="outcome ${v.cls}"><span class="${v.cls}">Verdict: ${v.text}</span>${ev ? ` <span class="muted small">(evaluator ${esc(ev.model)})</span><p>${esc(ev.reasons)}</p>` : ""}
			${s.self_report_summary ? `<p class="muted small">Agent's own report (${s.self_reported_success ? "success" : "failure"}): ${esc(s.self_report_summary)}</p>` : ""}</div>
		${stats(r, s)}
		${ev ? `<h2>Friction report</h2><div class="friction">${esc(ev.friction_report)}</div>` : ""}
		${s.self_report_friction ? `<details class="sys"><summary>Agent's own friction notes</summary><pre>${esc(s.self_report_friction)}</pre></details>` : ""}
		${s.asks?.length ? `<h2>Questions asked</h2><ul>${s.asks.map((a) => `<li>Turn ${a.turn}: ${esc(a.question)}</li>`).join("")}</ul>` : ""}
		${r.final_state ? `<details class="sys"><summary>Final state of the workspace</summary><pre>${esc(r.final_state)}</pre></details>` : ""}
		${s.system_prompt ? `<details class="sys"><summary>System prompt</summary><pre>${esc(s.system_prompt)}</pre></details>` : ""}
		<h2>Tokens read per turn</h2>
		${chart(turns)}
		<h2>Turns</h2>
		${turns.map((t, i) => turnCard(t, turns[i + 1], cumulative(turns, i))).join("")}`;
	bindChart(turns);
	bindDelete(`/api/runs/${r.id}`, `Delete run ${r.id}? This cannot be undone.`, `/tasks/${r.task_id}`);
	if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

function stats(r, s) {
	const box = (label, value, sub = "") =>
		`<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
	const extras = [r.parse_errors ? `${r.parse_errors} parse error${r.parse_errors > 1 ? "s" : ""}` : "",
		s.notes_reminders ? `${s.notes_reminders} notes reminder${s.notes_reminders > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
	return `<div class="stats">
		${box("Read tokens", n(r.read_tokens_total), "notes + results")}
		${box("Notes tokens", n(r.notes_tokens_total), `max ${n(r.notes_tokens_max)}`)}
		${box("Result tokens", n(r.result_tokens_total), `max ${n(r.result_tokens_max)}`)}
		${box("Turns", r.turns, extras)}
		${box("Overhead", n(r.overhead_tokens), "system prompt + task, once")}
		${box("Model output", n(r.model_output_tokens), "tokens written")}
		${box("Cost", `$${Number(r.cost_usd).toFixed(4)}`, r.backend === "claude-code" ? "notional (subscription)" : "")}
	</div>`;
}

function cumulative(turns, i) {
	let c = 0;
	for (let k = 0; k <= i; k++) c += turns[k].notes_tokens + turns[k].result_tokens;
	return c;
}

function niceTicks(max) {
	if (max <= 0) return { top: 1, ticks: [0] };
	const raw = max / 3;
	const pow = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
	const top = Math.ceil(max / step) * step;
	const ticks = [];
	for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
	return { top, ticks };
}

function chart(turns) {
	const max = Math.max(0, ...turns.map((t) => t.notes_tokens + t.result_tokens));
	const { top, ticks } = niceTicks(max);
	const pct = (v) => `${(100 * v) / top}%`;
	const every = Math.ceil(turns.length / 20);
	return `<div class="chart">
		<div class="legend"><span><i style="background:var(--s-notes)"></i>Notes read</span>
			<span><i style="background:var(--s-result)"></i>Result read</span></div>
		<div class="plot">
			${ticks.map((v) => `<div class="grid" style="bottom:${pct(v)}"><span>${n(v)}</span></div>`).join("")}
			<div class="bars">${turns.map((t, i) => `<div class="bar" data-i="${i}">
				${t.result_tokens ? `<div class="seg result" style="height:${pct(t.result_tokens)}"></div>` : ""}
				${t.notes_tokens ? `<div class="seg notes" style="height:${pct(t.notes_tokens)}"></div>` : ""}
			</div>`).join("")}</div>
		</div>
		<div class="xaxis">${turns.map((t, i) => `<span>${i % every === 0 ? t.turn : ""}</span>`).join("")}</div>
	</div>`;
}

function bindChart(turns) {
	document.querySelectorAll(".bar").forEach((bar) => {
		const t = turns[Number(bar.dataset.i)];
		bar.addEventListener("mousemove", (e) => {
			tooltip.innerHTML = `Turn ${t.turn}: notes ${n(t.notes_tokens)} + result ${n(t.result_tokens)} = ${n(t.notes_tokens + t.result_tokens)}`;
			tooltip.hidden = false;
			const w = tooltip.offsetWidth;
			tooltip.style.left = `${Math.min(e.clientX + 12, innerWidth - w - 8)}px`;
			tooltip.style.top = `${e.clientY + 14}px`;
		});
		bar.addEventListener("mouseleave", () => { tooltip.hidden = true; });
		bar.addEventListener("click", () => {
			history.replaceState(null, "", `#turn-${t.turn}`);
			document.getElementById(`turn-${t.turn}`)?.scrollIntoView({ behavior: "smooth" });
		});
	});
}

function actionBlock(a) {
	const label = (s) => `<div class="block-label">${s}</div>`;
	if (!a) return "";
	if (a.type === "run") return `<div class="block">${label(`Action: run${a.max_chars ? ` (max_chars ${a.max_chars})` : ""}`)}<pre>${esc(a.cmd)}</pre></div>`;
	if (a.type === "write_file")
		return `<div class="block">${label(`Action: write_file <code>${esc(a.path)}</code>`)}<pre class="scroll">${esc(a.content)}</pre></div>`;
	if (a.type === "edit_file")
		return `<div class="block">${label(`Action: edit_file <code>${esc(a.path)}</code>`)}
			<div class="muted" style="font-size:13px;margin-top:6px">old</div><pre class="scroll">${esc(a.old)}</pre>
			<div class="muted" style="font-size:13px;margin-top:6px">new</div><pre class="scroll">${esc(a.new)}</pre></div>`;
	if (a.type === "ask") return `<div class="block">${label("Action: ask")}<p>${esc(a.question)}</p></div>`;
	if (a.type === "finish") {
		return `<div class="block">${label("Action: finish")}
			<div class="finish"><span class="${a.success ? "ok" : "bad"}">${a.success ? "Success" : "Failure"}</span> (self-reported): ${esc(a.summary)}</div>
			${a.friction ? `<p class="muted small">Friction: ${esc(a.friction)}</p>` : ""}</div>`;
	}
	return `<div class="block">${label("Action (unrecognized)")}<pre>${esc(JSON.stringify(a, null, 2))}</pre></div>`;
}

function turnCard(t, next, cum) {
	const a = t.action_json ? JSON.parse(t.action_json) : null;
	const ops = t.notes_ops ? JSON.parse(t.notes_ops) : [];
	const truncated = t.result_shown && /\[\.\.\. \d+ chars, \d+ lines omitted/.test(t.result_shown);
	const resultNote = [
		next ? `read on turn ${next.turn}` : "",
		truncated ? `truncated; full result ${n(t.result_full_chars)} chars` : "",
	].filter(Boolean).join("; ");
	return `<section class="turn" id="turn-${t.turn}">
		<div class="turn-head"><h3><a href="#turn-${t.turn}">Turn ${t.turn}</a></h3>
			<span class="read">read: notes ${n(t.notes_tokens)} + result ${n(t.result_tokens)} (cumulative ${n(cum)})${t.notes_reminder ? "; notes reminder sent" : ""}</span></div>
		${t.parse_error ? `<div class="block"><div class="block-label bad">Parse error: ${esc(t.parse_error)}</div>
			<pre class="scroll">${esc(t.raw_response)}</pre></div>` : ""}
		${t.notes != null ? `<div class="block"><div class="block-label">Notes after this turn <span class="note">(${ops.length ? esc(ops.join(", ")) : "kept"})</span></div><pre>${esc(t.notes || "(empty)")}</pre></div>` : ""}
		${actionBlock(a)}
		${t.result_shown != null ? `<div class="block"><div class="block-label">Result
			${resultNote ? `<span class="note">(${resultNote})</span>` : ""}</div>
			<pre class="scroll">${esc(t.result_shown)}</pre></div>` : ""}
	</section>`;
}

route();
