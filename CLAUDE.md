# FlockBots — Claude Code Configuration

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## File Organization

- NEVER save to root folder — use the directories below
- Use `/coordinator/src` for coordinator source code (including chat providers, wizard, CLI)
- Use `/agents/prompts` for agent prompt templates
- Use `/dashboard` for dashboard frontend (Vercel-hosted)
- Use `/webhook-relay` for the Vercel-hosted webhook relay (WhatsApp + Supabase path)
- Use `/whatsapp` for WhatsApp-specific bot code (being refactored under `/coordinator/src/chat/`)
- Use `/scripts` for utility scripts
- Use `/docs` for documentation
- Use `/supabase/migrations` for the consolidated migration (fresh-install copy-paste target)

## Project Architecture

FlockBots is a multi-agent development coordinator that:
1. Picks tasks from a SQLite queue (chat provider, CLI, optional Linear sync)
2. Runs a pipeline: research → design (if UI) → dev → PR → review → merge → optional QA
3. Spawns Claude CLI sessions (`claude -p`) for each stage
4. L/XL tasks use swarm mode: the Claude session spawns parallel sub-agents via the Agent tool
5. Optionally syncs state to Supabase for a live web dashboard
6. Reviewer posts findings as GitHub PR reviews (APPROVE or REQUEST_CHANGES)
7. Notifies the user via their configured chat provider (Telegram or WhatsApp)

Required integrations: a chat provider (Telegram or WhatsApp), two GitHub Apps (PR creator + reviewer), and Claude auth (Max OAuth or `ANTHROPIC_API_KEY`).

Optional integrations (toggled during `flockbots init`):
- Linear (task source)
- Supabase + dashboard (web UI on Vercel)
- QA agent (Playwright post-merge browser tests)

Key patterns:
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Ensure input validation at system boundaries

## Build & Test

```bash
# Build coordinator
cd coordinator && npm run build

# Run with pm2 (production, native install)
pm2 start ecosystem.config.js

# Run directly (dev)
cd coordinator && npm run dev
```

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal

## Concurrency

- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message
- When spawning agents, use `run_in_background: true` and batch in ONE message
- After spawning, STOP — wait for results before proceeding
