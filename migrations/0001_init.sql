-- Tasks are plain text with a title; runs are uploaded run directories (gentl run format 1), reduced to what the site shows.
CREATE TABLE tasks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	text TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id INTEGER NOT NULL REFERENCES tasks(id),
	local_run_id TEXT NOT NULL,
	uploaded_by TEXT NOT NULL,
	uploaded_at TEXT NOT NULL,
	format INTEGER NOT NULL,
	gentl_version TEXT,
	model TEXT NOT NULL,
	backend TEXT,
	sandbox TEXT,
	image TEXT,
	turns INTEGER NOT NULL,
	read_tokens_total INTEGER NOT NULL,
	notes_tokens_total INTEGER NOT NULL,
	notes_tokens_max INTEGER NOT NULL,
	result_tokens_total INTEGER NOT NULL,
	result_tokens_max INTEGER NOT NULL,
	overhead_tokens INTEGER NOT NULL,
	model_output_tokens INTEGER NOT NULL,
	parse_errors INTEGER NOT NULL,
	cost_usd REAL NOT NULL,
	stop_reason TEXT,
	self_reported_success INTEGER,
	verdict INTEGER,               -- evaluator's verdict: 1 success, 0 failure, NULL not evaluated
	evaluator_model TEXT,
	summary_json TEXT NOT NULL,    -- the run's summary.json
	evaluation_json TEXT,          -- evaluation.json: verdict reasons and friction report
	final_state TEXT,              -- final-state.md
	UNIQUE (uploaded_by, local_run_id)
);
CREATE INDEX runs_task_id ON runs(task_id);

-- Each turn as the agent saw it (results as shown, not full results).
CREATE TABLE turns (
	run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	turn INTEGER NOT NULL,
	notes_tokens INTEGER NOT NULL,
	result_tokens INTEGER NOT NULL,
	notes TEXT,
	notes_ops TEXT,
	action_json TEXT,
	result_shown TEXT,
	result_full_chars INTEGER,
	parse_error TEXT,
	raw_response TEXT,
	notes_reminder INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (run_id, turn)
);
