# gentl-hub

A web hub for [gentl](https://github.com/magland/gentl), the readability test for codebases. It holds tasks (a title and plain text), shows the command to run each one, and collects the runs people upload, with per-model results, the evaluator's verdict and friction report, and a turn-by-turn viewer.

The public hub is at https://gentl-hub.jeremy-magland.workers.dev.

gentl and the hub share only two formats: the task text, which the hub serves at `GET /api/tasks/<id>`, and the run directory (format 1), which gentl uploads. A participant copies the command from a task's page, for example

```
gentl run https://<hub>/tasks/42 --backend claude-code --upload
```

With `--backend claude-code` the model calls go through the participant's Claude Code login, so no API key is needed. gentl shows the task and asks before running it, always clones the published repo (never a local copy), and uploads the run when it finishes. Uploads, new tasks and deletions need the hub's shared passcode; reading is public.

## Development

```
npm install
npm run migrate:local
echo 'PASSCODE=dev-passcode' > .dev.vars   # local passcode for writes
npm run dev                                 # http://127.0.0.1:8787 (or --port)
```

The app is a Cloudflare Worker (`src/index.ts`) with a D1 database (`migrations/`) and a static frontend (`public/`).

## Deploying

```
npx wrangler d1 create gentl-hub-db         # put the database_id in wrangler.jsonc
npm run migrate:remote
npx wrangler secret put PASSCODE
npm run deploy
```

## API

- `GET /api/tasks`: tasks with run and success counts.
- `GET /api/tasks/<id>`: the task (`title`, `text`), per-model results (runs, successes judged by the evaluator, median, IQR and fewest read tokens over successful runs), and its runs.
- `POST /api/tasks` (passcode): `{title, text, user}`.
- `GET /api/runs`, `GET /api/runs/<id>`: runs, and one run with its turns.
- `POST /api/runs` (passcode): an uploaded run, `{user, summary, evaluation, final_state, turns}`. Only runs of tasks from this hub, whose task text matches and which did not use a local copy, are accepted.
- `DELETE /api/tasks/<id>` (with its runs), `DELETE /api/runs/<id>` (passcode).

## License

Apache-2.0
