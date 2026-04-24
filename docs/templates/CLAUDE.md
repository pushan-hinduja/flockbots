# Claude Code / FlockBots Configuration

<!--
  This file lives at the root of your codebase and is read by every FlockBots
  agent (PM, UX, dev, reviewer, QA) at session start. It teaches them how to
  work in your project.

  Edit freely. Delete sections that don't apply. Keep it under a few hundred
  lines — agents read the whole file, long files burn tokens.
-->

## Project overview

<!-- One or two paragraphs. What is this codebase? Who uses it? What's the
     main user-facing functionality? -->

## Tech stack

- **Language:** <!-- e.g. TypeScript 5.6, Python 3.11 -->
- **Framework:** <!-- e.g. Next.js 15, FastAPI -->
- **Database:** <!-- e.g. PostgreSQL via Supabase, SQLite -->
- **Testing:** <!-- e.g. Vitest, Pytest -->
- **Package manager:** <!-- npm, pnpm, uv, poetry -->
- **Deploy target:** <!-- Vercel, Fly.io, self-hosted -->

## Project structure

```text
src/
  app/         # routes / pages
  components/  # reusable UI
  lib/         # shared utilities
  server/      # backend logic
tests/         # test suites
```

<!-- Adjust to match your repo. Callouts for non-obvious conventions. -->

## Commands agents should know

- **Install:** `npm install`
- **Dev server:** `npm run dev`
- **Test:** `npm test`
- **Lint:** `npm run lint`
- **Type check:** `npx tsc --noEmit`
- **Build:** `npm run build`

## Conventions

- File naming: <!-- kebab-case / snake_case / camelCase -->
- Component naming: <!-- PascalCase -->
- Imports: <!-- path aliases used -->
- Comments: explain WHY, not WHAT; no trailing "TODO" comments

## Things to avoid

- <!-- Anti-patterns specific to your codebase -->
- <!-- Deprecated APIs agents should steer clear of -->
- <!-- Directories that are off-limits (vendored, generated) -->

## Testing expectations

<!-- When agents should write tests, what kind (unit / integration / e2e),
     where to place them. -->

## Branch and PR conventions

- Base branch: <!-- main / master / develop -->
- Staging branch: <!-- staging, if you have one -->
- Branch naming: <!-- e.g. flockbots/<task-id>-short-slug -->
- PR titles: <!-- pattern you prefer -->

## Reviewer agent notes

<!-- Any project-specific things the reviewer should flag.
     Security invariants, perf constraints, etc. -->

## Secrets and credentials

- Never commit `.env`, `.env.local`, or any `*.key` / `*.pem` file.
- All secrets are loaded from environment variables at runtime.
- If unsure, ask before adding a new dependency that requires credentials.
