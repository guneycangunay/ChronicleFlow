# ADR 0001: Prefer explicit at-least-once delivery

- Status: Accepted
- Date: 2026-08-08

## Context

A workflow engine cannot atomically commit state with arbitrary downstream side effects. Describing the system as exactly-once would move an unresolved crash window into worker code and give operators the wrong mental model.

## Decision

ChronicleFlow uses time-bounded leases and redelivers the same deterministic command ID after expiry. Workers are required to deduplicate that identifier with their business mutation. A reported business failure, rather than a delivery timeout, advances the attempt counter.

## Consequences

- Lost responses and worker crashes are recoverable without inventing a second business attempt.
- Worker implementations must own an inbox/deduplication record or rely on downstream idempotency.
- Long-running work needs a future lease-renewal endpoint; the initial reference keeps leases bounded at five minutes.
- Operational tooling must surface commands that repeatedly expire without being completed.
