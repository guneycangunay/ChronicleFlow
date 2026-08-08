# Contributing

1. Open an issue describing the invariant or failure mode being changed.
2. Keep state transitions in the engine and infrastructure concerns behind `ExecutionStore`.
3. Add a deterministic test for success, retry, replay, and compensation behavior affected by the change.
4. Run `npm run check`, `npm run test:coverage`, and `npm run build` before opening a pull request.

Commits should be focused and explain intent. Pull requests that weaken idempotency, optimistic concurrency, or checksum validation need an architecture decision record.
