# Workflows & Architecture

> **Template.** End-to-end user workflows and a high-level map of how the system is built. The dev agent and PM agent both lean on this.

## Primary user workflows

### Workflow 1: <!-- Name, e.g. "Sign up and onboard" -->

1. <!-- Step: what the user does + what the system does -->
2. <!-- Step -->
3. <!-- Step -->

### Workflow 2: <!-- Name -->

<!-- ... -->

## High-level architecture

<!-- A paragraph or ASCII diagram showing the major pieces: frontend / backend / DB / background jobs / third-party services. Who talks to whom. -->

```text
[Frontend] → [API] → [DB]
              ↓
           [Worker]
```

## Key technical decisions

<!-- Pointers or cross-refs to skills/code/architecture-decisions.md for ADR-style depth. Summarize the ones most relevant to daily work here. -->

- **<!-- Decision -->:** <!-- One-line rationale -->

## Integrations

<!-- External services the product depends on. Auth providers, payment, analytics, email, etc. How each is wired. -->

## Background processing

<!-- Cron jobs, queues, webhooks. What runs when. Failure handling. -->
