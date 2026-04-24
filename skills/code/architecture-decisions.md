# Architecture Decisions

> **Template.** ADR-style notes capturing key architectural choices. Keep each entry short — the goal is agents understanding the WHY, not a full design doc.

## Format

Each decision has a heading, a one-line summary, a "why" paragraph, and constraints that flow from it.

---

## Example: Use PostgreSQL over a document store

**Why:** Our domain is relational (users → orgs → projects → tasks). Query patterns are heavy on joins. We don't need horizontal scale to justify the operational cost of sharded Mongo.

**Constraints:** All new features use the relational schema. Denormalize only with a clear read-pattern justification.

---

<!-- Add your decisions below. Suggested topics:
     - Framework choice (why this one, not alternatives)
     - State management
     - Authentication strategy
     - Background job processing
     - Deploy target (Vercel / AWS / self-hosted)
     - AI model routing, if applicable -->
