# Security Policy

## Reporting a vulnerability

Don't open a public issue for anything that could be exploited. Instead, email the maintainer directly with:

- A description of the issue
- Steps to reproduce
- The impact you've assessed
- Any suggested fix

We'll acknowledge receipt within a few days and coordinate disclosure privately before publishing any fix.

## What's in scope

- Vulnerabilities in the coordinator, wizard, or CLI
- Credential leakage paths (env loading, `.pem` handling, logs)
- Privilege escalation via GitHub App scopes
- Supply-chain issues in dependencies we pin

## What's out of scope

- Vulnerabilities in upstream libraries we depend on — file those with the library
- Rate-limit behavior that's a Claude / Anthropic concern
- Issues that require compromising the host machine first (like reading `.env`)

## Threat model — the short version

FlockBots runs on a user's machine and:

- Reads / writes local files in `~/.flockbots/` and `TARGET_REPO_PATH`
- Spawns the Claude CLI with the user's OAuth session or API key
- Makes authenticated HTTPS requests to GitHub (two GitHub Apps), Anthropic, Linear (optional), Supabase (optional), Telegram / Meta WhatsApp (one of the two)
- Exposes a local HTTP server on port 3001 *only* when CHAT_PROVIDER=whatsapp and Supabase is disabled

The GitHub Apps are scoped to the repos the user explicitly installs them on. Each flock keeps its own credentials at `~/.flockbots/instances/<slug>/.env` (mode 0600) and `~/.flockbots/instances/<slug>/keys/*.pem` (mode 0600); shared values (Supabase project, dashboard login) are duplicated across flock `.env` files but kept inside each flock's own 0600 directory. The coordinator does not send your code to any third party — the Claude CLI does that, and only within the specific agent sessions the coordinator spawns.

## Secrets hygiene

If you accidentally commit a secret:

1. Rotate it immediately (new API key / new GitHub App / new Supabase service role).
2. Open an issue only after the old secret is dead.
3. If a `.env` file is leaking through a log, that's a bug — please report it.
