# Code Conventions

> **Template.** Edit to describe how your project's code is structured so agents write code that matches your style. Delete sections that don't apply.

## Tech stack

- **Language(s):** <!-- e.g. TypeScript 5.6, Python 3.11 -->
- **Framework(s):** <!-- e.g. Next.js 15, FastAPI, Rails 8 -->
- **Database:** <!-- e.g. PostgreSQL via Supabase, SQLite -->
- **Testing:** <!-- e.g. Vitest, Pytest, Jest -->
- **Package manager:** <!-- npm, pnpm, uv, poetry -->

## Project structure

```text
src/
  components/   <!-- what goes here -->
  lib/          <!-- what goes here -->
  routes/       <!-- what goes here -->
```

## Naming

- Files: <!-- kebab-case / snake_case / camelCase -->
- React/Vue components: <!-- PascalCase file + PascalCase export -->
- Functions/variables: <!-- camelCase / snake_case -->
- Constants: <!-- SCREAMING_SNAKE_CASE -->
- DB tables: <!-- snake_case plural -->

## API route patterns

<!-- How do you structure API routes? Auth middleware? Error envelope? Pagination? -->

## Database patterns

<!-- Migration tool + workflow. Query style (ORM / raw / query builder). Transaction handling. -->

## TypeScript / type rules

- Strict mode: <!-- on/off -->
- `any` policy: <!-- forbidden / last-resort -->
- Import paths: <!-- alias config, e.g. @/ -->

## Styling

<!-- Tailwind / CSS modules / styled-components / vanilla. Design tokens. Dark mode. -->

## Testing

- When to write tests: <!-- every function / only business logic / integration-only -->
- Coverage expectation: <!-- target % or "no target" -->
- Test placement: <!-- colocated / tests/ dir -->

## Things to avoid

- <!-- Anti-patterns specific to your codebase -->
- <!-- Deprecated APIs to steer clear of -->
