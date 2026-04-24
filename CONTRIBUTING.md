# Contributing to FlockBots

Thanks for opening the repo. Here's how to get a dev loop going and land a change that won't get bounced in review.

## Set up

```bash
git clone https://github.com/pushan-hinduja/flockbots.git
cd flockbots
cd coordinator && npm install && npm run build
cd ../dashboard && npm install
```

Run the coordinator from the repo root in dev mode:

```bash
cd coordinator && npm run dev
```

`ts-node` compiles and runs the source directly — handy when you're iterating on an agent prompt or a pipeline tweak.

## Branches + PRs

- Branch from `main`.
- Keep PRs focused. Refactors in one PR, features in another.
- Squash merges. One-line PR titles that describe the *why*, not the *what*.
- Link the related issue if there is one.

## Code style

- TypeScript strict mode is on; don't turn it off.
- No `any` except at boundaries you can't type — add a comment if you use one.
- Keep files under ~500 lines; split if they grow past that.
- Comments explain *why*, not *what*. The code says what.
- Don't add dependencies casually. Every new dep is a future security PR.

## Testing

We're light on automated tests right now. Minimum bar for a PR:

- `cd coordinator && npm run build` must pass (tsc clean).
- If you touch pipeline logic, walk a task through manually in a scratch repo.
- If you touch the wizard, run `flockbots init` end-to-end and confirm it still reaches the outro.

Tests live alongside the code they exercise when they exist. Feel free to add them.

## Agent prompts

The prompts in `agents/prompts/*.md` are load-bearing. Small changes can swing model behavior a lot. When editing:

- Describe the behavior change in the PR body. Reviewers will want to understand what shifts.
- Keep the structural sections (header, steps, output format) stable — other prompts reference them.
- If you add a section, check that the reviewer / validator can still parse the output.

## Schema migrations

`supabase/migrations/consolidated.sql` is the bootstrap for fresh installs. Additive changes (new column, new table) go in a new numbered file — **never** edit `consolidated.sql` in a way that breaks idempotent re-runs.

The `flockbots_migrations` table tracks versions. If you add a migration, append an `INSERT INTO flockbots_migrations (version) VALUES ('x.y.z')` so future upgrades know where they are.

## Commit messages

Write them like you want to read them six months from now. Don't worry about conventional commit prefixes unless you're already in the habit.

```
Short subject line (≤72 chars)

Optional longer body explaining the why. Wrap at 72.
```

## Running the hardware

The coordinator expects a long-running process. For local dev, tmux / screen / just an open terminal is fine. For a real deploy, use pm2 (the default) — `ecosystem.config.js` at the repo root is wired to start it.
