# Skills Index

Entry point for FlockBots agents. Read at session start, then load only the files relevant to your task — don't load everything.

If a file referenced below does not exist, proceed without it. The codebase and the task's context pack are authoritative; these guides capture the WHY that code alone can't.

> **These files are starter templates.** Edit them to describe your product, your stack, and your conventions. The more specific, the better agents match your intent. If a section doesn't apply, delete it — agents handle missing content gracefully.

## Product knowledge

| File | Load when you need |
|------|-------------------|
| `skills/product/vision.md` | Who the user is, product scope, success metrics, what your product is not |
| `skills/product/domain.md` | Definitions of domain entities (e.g. User, Organization, Order) |
| `skills/product/workflows.md` | End-to-end user workflows + high-level architecture + key technical decisions |

## Design guidance (UX agent, frontend dev)

| File | Load when you need |
|------|-------------------|
| `skills/design/principles.md` | Brand, typography, color system, spacing, dark mode — the visual language rules |
| `skills/design/components.md` | Buttons, inputs, cards, modals, badges, tables, icons — when to use each and how |
| `skills/design/layouts.md` | App shell, auth pages, detail pages — standard page structures |
| `skills/design/responsive.md` | Breakpoints, mobile vs desktop behaviors, responsive utility patterns |
| `skills/design/motion.md` | Animation classes, hover transitions, loading states — the motion vocabulary |
| `skills/design/website.md` | Marketing site guidelines (if separate from the web app) |

## Engineering guidance (dev agent)

| File | Load when you need |
|------|-------------------|
| `skills/code/conventions.md` | Tech stack, project structure, naming, API patterns, DB patterns, styling, type rules |
| `skills/code/architecture-decisions.md` | Key architectural decisions (ADR-style notes) |

## Review guidance (reviewer agent)

| File | Load when you need |
|------|-------------------|
| `skills/review/checklist.md` | PR review checklist — correctness, security, quality, scope |

## Knowledge graph (optional)

The target codebase can be indexed by [graphify](https://graphify.net) into a queryable knowledge graph. Query via graphify's built-in MCP server — tools exposed under `mcp__graphify__*`.

Prefer graph queries over blind grep for well-defined lookups — orders of magnitude cheaper in tokens.

If the graph isn't built, the MCP will be absent and agents fall back to `grep`/`glob`. Run `scripts/build-knowledge-graph.sh` to build it.
