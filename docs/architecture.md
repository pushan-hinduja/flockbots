# FlockBots Architecture

A plain-English tour of how FlockBots is wired so contributors (and curious users) can orient quickly.

## One paragraph version

FlockBots is a Node process (the **coordinator**) that runs a SQLite task queue. Tasks enter the queue from a chat provider (Telegram, Slack, or WhatsApp), the CLI (`flockbots task add`), or Linear sync. A cron inside the coordinator picks tasks up and walks them through a fixed pipeline. Each stage of the pipeline spawns a `claude -p` subprocess with a role-specific prompt. The coordinator authenticates to GitHub via two GitHub Apps (one for PRs, one for reviews) and optionally mirrors state to Supabase for the web dashboard.

## The pipeline

```
inbox → researching → [designing] → dev_ready → developing → review_pending → reviewing → [merged → qa]
```

| Stage | Agent | Entry | Exit |
|-------|-------|-------|------|
| inbox | (queue) | Task created | scheduler picks it up |
| researching | PM | Task description | Spec + context pack |
| designing | UX *(skipped for backend)* | Spec | Design tokens, screens |
| developing | Dev | Spec + design | PR opened |
| reviewing | Reviewer | PR URL | APPROVE or REQUEST_CHANGES |
| merged | — | PR merged | QA queued if enabled |
| qa | QA | Staging URL | Pass/fail + fix task if fail |

Each stage uses a dedicated prompt in `agents/prompts/`. Large tasks enter "swarm mode": the dev session uses the Agent tool to spawn parallel sub-agents per file.

## Modules

```text
coordinator/src/
├── index.ts              Startup, cron schedules, graceful shutdown
├── pipeline.ts           The big state machine — one stage at a time
├── queue.ts              SQLite queue + event/usage/escalation logging
├── scheduler.ts          Task picker — respects rate limits, peak hours
├── rate-limiter.ts       Budget estimation, calibration
├── session-manager.ts    spawn(claude -p) with retries, cwd, worktree
├── worktree-manager.ts   Git worktree setup/teardown per task
├── github-auth.ts        @octokit/auth-app JWT issuance for both apps
├── supabase-sync.ts      Async dual-write to Supabase (no-op if disabled)
├── notifier.ts           Outbound chat via the ChatProvider interface
├── chat/
│   ├── provider.ts       Interface
│   ├── telegram.ts       Long-polling with offset persistence
│   ├── slack.ts          Socket Mode (WebSocket) — no public URL needed
│   └── index.ts          Factory reading CHAT_PROVIDER env
├── webhook/
│   └── server.ts         Local HTTP server for WhatsApp inbound (no-Supabase fallback)
├── paths.ts              FLOCKBOTS_HOME resolution + state dirs
├── output-validator.ts   Ensures agent output has the required sections
├── test-gate.ts          Runs lint / typecheck / test after dev
├── task-actions.ts       Retry / dismiss / revert-stage from dashboard
├── staleness-checker.ts  Escalate tasks that sit too long
├── health-monitor.ts     Periodic sanity checks (disk, processes)
├── linear-sync.ts        Pull-in from Linear (optional)
└── cli/
    ├── index.ts          Command dispatcher (init/doctor/upgrade/task/version/help)
    ├── wizard.ts         The `flockbots init` flow
    ├── wizard-github.ts  GitHub App manifest + callback server
    ├── doctor.ts         Prereq + config readout
    ├── prereq.ts         System checks (Node, git, claude, etc.)
    ├── upgrade.ts        git pull + build + restart
    ├── task.ts           `task add` subcommand
    └── env.ts            .env loader for CLI entry points
```

## Data

- **SQLite** (`~/.flockbots/data/flockbots.db`) — source of truth for the queue, events, usage, escalations, agent-specific state.
- **File system** (`~/.flockbots/tasks/<id>/`) — per-task artifacts: context packs, spec docs, review notes. Each task owns its own git worktree inside the target repo.
- **Supabase** (optional) — dual-write mirror of SQLite for the dashboard. Dashboard reads via Supabase realtime. See `supabase/migrations/consolidated.sql`.

## Why two GitHub Apps?

The coordinator makes PRs *and* reviews them. With one app, the PR author and the reviewer would be the same GitHub identity — PRs would show "AI Agent approved their own PR" which is terrible signal. Two apps gives you two identities:

- **FlockBots Agent** — opens and pushes to PR branches
- **FlockBots Reviewer** — posts formal reviews (APPROVE / REQUEST_CHANGES)

The setup wizard creates both via GitHub's manifest flow, so there's no manual App ID / private-key juggling.

## Why long-polling for Telegram? Why Socket Mode for Slack?

No public URL required. The coordinator can run on a laptop behind NAT with no webhook exposed. Telegram's first boot establishes a high-watermark offset via `getUpdates(offset=-1, limit=1)` so the coordinator doesn't replay the last 24h of buffered messages. Slack's Socket Mode opens a WebSocket back to Slack so inbound events arrive without any ingress path to the coordinator.

## Why Supabase for the dashboard?

- Managed Postgres + realtime out of the box, free tier is plenty for a single operator.
- Row-level security means the dashboard is serverless — just a static React app that reads with the anon key. No custom backend to host.
- Storage bucket for QA screenshots and recordings.

If you don't want Supabase, the coordinator skips all sync writes and the dashboard is simply absent. Chat stays the source of truth.

## Where state changes propagate

```
Chat message  ──► coordinator.routeMessage
                  ├── writes to SQLite queue
                  └── (if Supabase on) fires syncToSupabase('task_update')
                                        └── dashboard subscribes via realtime
```

The pipeline state machine re-runs on every cron tick. All state transitions flow through `updateStatus()` in `pipeline.ts`, which logs an event and triggers a sync. This keeps SQLite and Supabase eventually consistent — SQLite always wins if they disagree.

## Startup sequence

1. `ensureStateDirs()` — create `data/`, `tasks/`, `logs/`, `keys/` if missing
2. `initDatabase()` — open SQLite, run migrations, recover stuck sessions
3. `initSupabase()` — connect if env is present, otherwise noop
4. `initLinear()` — same pattern
5. Claude CLI auth check (spawn `claude -p 'say ok'`)
6. `fullSync()` — push SQLite → Supabase baseline
7. `getChatProvider().healthCheck() + start()` — verify credentials, begin receiving
8. Cron schedules kick in

## Rate limiting

Peak hours (5-11am PT weekdays) defer L/XL tasks. A soft-calibration loop tracks rate-limit hits and relaxes gradually over 30 min after a hit. Budget is estimated conservatively; hard-limits are enforced by Anthropic's API, not by the coordinator.

## Error handling philosophy

- Boundaries (Chat input, GitHub API, Supabase write) always validate or wrap.
- Agent output passes through `output-validator.ts` before being trusted.
- Agent retries are capped — dev retries 5 times with accumulated review feedback, reviewer retries 5 times scoped to verify-fixes-only.
- Escalations (the agent is stuck, a human needs to decide) bubble to chat as structured prompts the operator can answer with `/answer <task-id> <text>`.

## File size policy

Anything over ~500 lines is a candidate for splitting. The pipeline orchestration file is the main offender and gets a pass for now because its logic benefits from linearity.
