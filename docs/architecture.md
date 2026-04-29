# FlockBots Architecture

A plain-English tour of how FlockBots is wired so contributors (and curious users) can orient quickly.

## One paragraph version

FlockBots is a Node process (the **coordinator**) that runs a SQLite task queue. As of v1.1 you can run **multiple coordinators** on one machine — one per target repo, called an *instance* internally and a *flock* in user docs. Tasks enter each instance's queue from its chat provider (Telegram, Slack, or WhatsApp), the CLI (`flockbots task add -i <slug>`), or Linear sync. A cron inside each coordinator picks tasks up and walks them through a fixed pipeline. Each stage spawns a `claude -p` subprocess with a role-specific prompt. The coordinator authenticates to GitHub via two GitHub Apps (one for PRs, one for reviews) and optionally mirrors state to Supabase for the web dashboard, with every row keyed by `instance_id` so the dashboard's switcher can scope panels per instance.

## The pipeline

```
inbox → researching → [designing → wireframes_rendering → design_validation → awaiting_design_approval]
      → dev_ready → developing → review_pending → reviewing → [merged → qa]
```

The bracketed UI sub-pipeline runs only when the task touches UI. PM marks `skip_design: true` for backend / config / infra tasks, which routes the task straight from `researching` to `dev_ready`.

| Stage | Agent | Entry | Exit |
|-------|-------|-------|------|
| inbox | (queue) | Task created | scheduler picks it up |
| researching | PM | Task description | Spec + context pack |
| designing | UX *(skipped for backend)* | Context pack | HTML wireframes + `index.json` |
| wireframes_rendering | (coordinator) | Wireframes written | PNGs uploaded to Supabase + per-screen `mediaUrls` written back to `index.json` |
| design_validation | PM | Rendered proofs | `approved` or `revise` (≤2 PM rounds, then force-promote) |
| awaiting_design_approval | (human) | Proofs sent to chat | Operator reply via `/design_reply` — approves or describes per-screen changes |
| developing | Dev | Approved wireframes + spec | PR opened |
| reviewing | Reviewer | PR URL | APPROVE or REQUEST_CHANGES |
| merged | — | PR merged | QA queued if enabled |
| qa | QA | Staging URL | Pass / fail + visual fidelity report (drift_major spawns a child task) |

Each stage uses a dedicated prompt in `agents/prompts/`. Large tasks enter "swarm mode": the dev session uses the Agent tool to spawn parallel sub-agents per file.

**Design rework loops.** Both the PM-validation step and the human-approval step can route back to `design_pending` for another designer pass. PM revisions are capped at 2 (then force-promoted to the human gate so they don't ping-pong forever). Human revisions are unbounded — every reply that isn't `approved` triggers another round, and each round increments `context.json#design.round` so the renderer keeps PNGs from prior rounds at `wireframes/round-N/` for historical reference.

## Modules

```text
coordinator/src/
├── index.ts                Startup, cron schedules, graceful shutdown
├── pipeline.ts             The big state machine — one stage at a time
├── design-pipeline.ts      Designing → wireframes_rendering → design_validation stages (split out of pipeline.ts; lazy-imports back into pipeline.ts to break the cycle)
├── wireframe-renderer.ts   Drives Playwright over the designer's HTML; uploads PNGs to the Supabase wireframes bucket; tracks per-screen versions for partial re-render
├── design-notify.ts        Sends rendered proofs to the operator with caption + per-screen images; on rework rounds, only attaches the screens the designer just touched
├── design-feedback-parser.ts Haiku parser — operator's free-form reply → {approved, feedback: {"screen-id": "..."}}
├── design-reply-handler.ts /design_reply command body → state transition (dev_ready or design_pending) + design-feedback.md
├── task-media-upload.ts    Shared Supabase Storage upload helper (qa-media + wireframes); thin wrappers in pipeline.ts and wireframe-renderer.ts
├── queue.ts                SQLite queue + event/usage/escalation logging
├── scheduler.ts            Task picker — respects rate limits, peak hours
├── rate-limiter.ts         Budget estimation, calibration; reads shared rate-limit-state.json
├── session-manager.ts      spawn(claude -p) with retries, cwd, worktree
├── worktree-manager.ts     Git worktree setup/teardown per task
├── github-auth.ts          @octokit/auth-app JWT issuance for both apps
├── supabase-sync.ts        Async dual-write — every row carries instance_id; upsertInstance/heartbeatInstance for liveness
├── notifier.ts             Outbound chat via the ChatProvider interface
├── chat/
│   ├── provider.ts         Interface
│   ├── telegram.ts         Long-polling with offset persistence
│   ├── slack.ts            Socket Mode (WebSocket) — no public URL needed
│   └── index.ts            Factory reading CHAT_PROVIDER env
├── webhook/
│   └── server.ts           Local HTTP server for WhatsApp inbound (no-Supabase fallback)
├── paths.ts                FLOCKBOTS_HOME (shared root) + flockbotsInstanceHome (per-instance) resolution
├── output-validator.ts     Ensures agent output has the required sections
├── test-gate.ts            Runs lint / typecheck / test after dev
├── task-actions.ts         Retry / dismiss / revert-stage from dashboard
├── staleness-checker.ts    Escalate tasks that sit too long
├── health-monitor.ts       Periodic sanity checks (disk, processes)
├── linear-sync.ts          Pull-in from Linear (optional, with team+project filtering)
└── cli/
    ├── index.ts            Command dispatcher (init/doctor/instances/upgrade/task/kg/dashboard/webhook/remove/uninstall)
    ├── wizard.ts           The `flockbots init` flow — creates new instances or reconfigures existing ones
    ├── wizard-instances.ts Multi-instance picker (create / reconfigure-one / reconfigure-shared)
    ├── wizard-github.ts    GitHub App manifest + reuse-existing flow (JWT pre-flight checks)
    ├── wizard-linear.ts    Linear team + project picker, blocks (team_id, project_id) collisions
    ├── doctor.ts           Prereq + per-instance config readout (-i <slug> filter)
    ├── instances.ts        `flockbots instances` — list registered instances + pm2 status
    ├── remove.ts           `flockbots remove` — archive a single instance (Supabase + pm2 + dir)
    ├── prereq.ts           System checks (Node, git, claude, pm2) + offerPm2Install
    ├── upgrade.ts          git pull + build + restart all instances via pm2
    ├── task.ts             `task add` subcommand
    └── env.ts              Per-instance .env loader + extractInstanceFlag helper
```

## Data

- **SQLite** (`~/.flockbots/instances/<slug>/data/flockbots.db`) — per-instance source of truth for the queue, events, usage, escalations, agent-specific state. Each instance has its own DB; nothing is shared at the SQLite level.
- **File system** (`~/.flockbots/instances/<slug>/tasks/<id>/`) — per-task artifacts: context packs, spec docs, review notes. Each task owns its own git worktree inside its instance's target repo.
- **Supabase** (optional) — single shared project for all instances. Dual-write mirror of every instance's SQLite. Every coordinator-written table has `instance_id NOT NULL REFERENCES flockbots_instances(id)` and a composite PK `(instance_id, id)`, so two instances can have task `abc123` without collision. Dashboard reads via Supabase realtime with `filter: instance_id=eq.<slug>` to scope panels. See `supabase/migrations/consolidated.sql`.

## Multi-instance lifecycle

```
flockbots init  ──► instances/<slug>/.env written; pm2 picks it up on next start
                    │
                    └── on coordinator startup: upsertInstance() registers slug
                                                in flockbots_instances (Supabase)
                                                and explicitly clears archived_at
                                                (so restarting a removed slug un-
                                                archives it intentionally)

coordinator running  ──► heartbeatInstance() every 2 min refreshes last_seen_at
                          │
                          └── dashboard reads last_seen_at < 5 min as "online"

flockbots remove  ──► reads .env (target repo, GitHub App IDs, chat provider)
                      ├── archives Supabase row (archived_at = now())
                      ├── pm2 stop + delete + save flockbots:<slug>
                      ├── cleans .worktrees inside the instance's target repo
                      └── rm -rf instances/<slug>/

coordinator restart ──► upsertInstance() clears archived_at — bringing a removed
                        slug back manually re-activates it in the dashboard
```

### Per-instance vs shared resources

| Resource                          | Scope          | Path                                              |
|-----------------------------------|----------------|---------------------------------------------------|
| Coordinator code                  | Shared         | `~/.flockbots/coordinator/`                       |
| Agent prompts                     | Shared         | `~/.flockbots/agents/prompts/`                    |
| Skills template (seed)            | Shared         | `~/.flockbots/skills-template/`                   |
| Supabase migration                | Shared         | `~/.flockbots/supabase/migrations/`               |
| Cross-run state (deploy URLs)     | Shared         | `~/.flockbots/state.json`                         |
| Claude rate-limit budget          | Shared         | `~/.flockbots/rate-limit-state.json` (atomic)     |
| pm2 ecosystem config              | Shared (auto)  | `~/.flockbots/ecosystem.config.js`                |
| Runtime config                    | Per-instance   | `~/.flockbots/instances/<slug>/.env`              |
| SQLite queue + event log          | Per-instance   | `~/.flockbots/instances/<slug>/data/`             |
| Task worktrees + artifacts        | Per-instance   | `~/.flockbots/instances/<slug>/tasks/`            |
| pm2 logs                          | Per-instance   | `~/.flockbots/instances/<slug>/logs/`             |
| GitHub App private keys           | Per-instance   | `~/.flockbots/instances/<slug>/keys/`             |
| Knowledge graph (graph.json)      | Per-instance   | `~/.flockbots/instances/<slug>/skills/kg/`        |

The Claude rate-limit budget is shared because all instances on one machine usually share one Claude OAuth session / API key — racing them against one another against a single rate limit would just trip the limit faster. Coordinator processes coordinate via atomic-rename writes to `rate-limit-state.json`.

### Shared values across instance .envs

A handful of `.env` keys must be identical across every instance (the dashboard reads one URL, the relay holds one verify token):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `WHATSAPP_VERIFY_TOKEN` (one relay, one token)

The wizard propagates changes diff-based: when reconfigure changes a shared key, only that key gets written to every other instance's `.env`. With ≥2 instances, the picker also offers a "Reconfigure shared settings" shortcut.

### Per-instance webhook routing (WhatsApp)

The webhook-relay is **one Vercel deployment** shared across instances. Each instance gets its own URL path: `/api/webhook/<slug>`. The relay validates the slug against `[a-z0-9-]{2,32}`, stamps `instance_id=<slug>` on every `webhook_inbox` insert, and the matching coordinator polls for its rows. Adding a WhatsApp instance means: (1) wizard prints a slug-specific URL, (2) operator pastes it into Meta's webhook config for that WhatsApp number. No relay redeploy needed per instance.

### Vercel deployment model

Both `flockbots dashboard deploy` and `flockbots webhook deploy` are wrappers around the `vercel` CLI (via `npx --yes vercel`), running against `~/.flockbots/dashboard/` and `~/.flockbots/webhook-relay/` respectively. We picked CLI-against-local-source over the older "import from public repo" model for two reasons:

1. **Decoupled upgrade cadence.** Importing the public `pushan-hinduja/flockbots` repo would auto-deploy every push to `flockbots/main` straight to user dashboards — a footgun for breaking releases (v1.0 → v1.1 schema changes would silently break existing dashboards). Local-source means the user controls when their dashboard advances, via `flockbots upgrade`.
2. **Lockstep upgrades.** `flockbots upgrade` pulls coordinator + dashboard + relay source in one git operation, then redeploys any linked Vercel projects (`isVercelLinked()` checks for `.vercel/project.json` in each subdir). Dashboard schema reads always match coordinator schema writes — no drift window.

Auth is browser-based on first run (`vercel login`); the token is shared across every flock on the machine. `VERCEL_TOKEN` env var bypasses the prompt for headless / CI use. Project name conflicts within a Vercel scope are handled by `vercel link`'s built-in "Link to existing project?" prompt, surfaced via a wizard note before the interactive step.

## Why two GitHub Apps?

The coordinator makes PRs *and* reviews them. With one app, the PR author and the reviewer would be the same GitHub identity — PRs would show "AI Agent approved their own PR" which is terrible signal. Two apps gives you two identities:

- **FlockBots Agent** — opens and pushes to PR branches
- **FlockBots Reviewer** — posts formal reviews (APPROVE / REQUEST_CHANGES)

The setup wizard creates both via GitHub's manifest flow, so there's no manual App ID / private-key juggling. With multiple instances, the wizard performs a JWT pre-flight against each existing FlockBots Agent / Reviewer pair (signs a token with the saved `.pem`, calls `GET /app`) and offers reuse — install the same App on a new repo instead of creating a fresh pair, useful when one operator runs many flocks against the same GitHub org.

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

1. Validate `FLOCKBOTS_INSTANCE_ID` is set (pm2 sets it per app via `ecosystem.config.js`); fail-fast if not — every Supabase write requires it for the FK
2. `ensureStateDirs()` — create per-instance `data/`, `tasks/`, `logs/`, `keys/` if missing
3. `initDatabase()` — open SQLite, run migrations, recover stuck sessions
4. `initSupabase()` — connect if env is present, otherwise noop
5. `upsertInstance()` — register this slug in `flockbots_instances` BEFORE any task/event write (FK requirement); also clears `archived_at` if set
6. `initLinear()` — same pattern
7. Claude CLI auth check (spawn `claude -p 'say ok'`)
8. `fullSync()` — push SQLite → Supabase baseline
9. `getChatProvider().healthCheck() + start()` — verify credentials, begin receiving
10. Cron schedules kick in (including a 2-min `heartbeatInstance()` for last_seen_at)

## Rate limiting

Peak hours (5-11am PT weekdays) defer L/XL tasks. A soft-calibration loop tracks rate-limit hits and relaxes gradually over 30 min after a hit. Budget is estimated conservatively; hard-limits are enforced by Anthropic's API, not by the coordinator.

## Error handling philosophy

- Boundaries (Chat input, GitHub API, Supabase write) always validate or wrap.
- Agent output passes through `output-validator.ts` before being trusted.
- Agent retries are capped — dev retries 5 times with accumulated review feedback, reviewer retries 5 times scoped to verify-fixes-only.
- Escalations (the agent is stuck, a human needs to decide) bubble to chat as structured prompts the operator can answer with `/answer <task-id> <text>`.

## File size policy

Anything over ~500 lines is a candidate for splitting. The pipeline orchestration file is the main offender and gets a pass for now because its logic benefits from linearity.
