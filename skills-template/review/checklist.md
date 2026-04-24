# Code Review Checklist

Use this when reviewing agent-authored PRs. Every item is either a pass, a concern to flag, or a blocker that requires changes.

> **Customize** by adding project-specific checks. The sections below are generic minimums.

## Correctness

- [ ] Code does what the task description asked for
- [ ] No obvious bugs (off-by-one, null handling, race conditions, wrong operator)
- [ ] Edge cases considered (empty input, large input, concurrent access)
- [ ] Error paths are handled — no swallowed exceptions
- [ ] Tests exist for non-trivial logic
- [ ] Existing tests still pass

## Security

- [ ] No secrets, credentials, or API keys in code
- [ ] User input validated at boundaries (API handlers, form submissions)
- [ ] No SQL injection, XSS, path traversal, command injection
- [ ] Auth / authorization checks present on protected operations
- [ ] Sensitive data not logged
- [ ] CORS, CSP, and other headers unchanged or tightened, not loosened

## Quality

- [ ] Follows project conventions (see `skills/code/conventions.md`)
- [ ] No dead code, unused imports, or debug logs
- [ ] Comments explain WHY, not WHAT — and only when non-obvious
- [ ] No over-engineering: no premature abstractions, no hypothetical flexibility
- [ ] Files stay reasonable in size (~500 lines); long files get flagged for split
- [ ] Naming is descriptive and consistent with the codebase
- [ ] No new dependencies without justification

## Scope

- [ ] Changes limited to the task at hand
- [ ] No unrelated refactoring bundled in
- [ ] No drive-by formatting changes (creates review noise)
- [ ] Migrations, if any, are reversible or explicitly one-way with rationale

## Performance (when touched)

- [ ] No N+1 queries introduced
- [ ] Expensive operations are cached / batched / deferred where appropriate
- [ ] No synchronous I/O in hot paths

## Reviewer output format

Return one of:
- **APPROVE** — all checks pass, no concerns.
- **REQUEST_CHANGES** — one or more blockers. List each with file:line and what needs to change.

For flags that aren't blockers, note them in a "Suggestions" section of the review body so the author can address them without blocking the merge.
