# ChronicleFlow

[![CI](https://github.com/guneycangunay/ChronicleFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/guneycangunay/ChronicleFlow/actions/workflows/ci.yml)
[![CodeQL](https://github.com/guneycangunay/ChronicleFlow/actions/workflows/codeql.yml/badge.svg)](https://github.com/guneycangunay/ChronicleFlow/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

ChronicleFlow is a compact workflow orchestration engine for operations that cannot be completed in one database transaction. It models durable execution, leased work delivery, bounded retries, idempotent completion, and reverse-order saga compensation without hiding the failure cases.

The repository is intentionally small enough to understand in an interview and deep enough to discuss production trade-offs. The bundled store persists snapshots with atomic file replacement; the engine is isolated behind a repository boundary so a transactional database adapter can replace it.

## What it demonstrates

- deterministic command identifiers and idempotent completion
- expiring worker leases with safe redelivery
- retry budgets with explicit backoff scheduling
- reverse-order compensation after a terminal step failure
- compare-and-swap revisions to reject stale writers
- atomic, checksummed snapshots and crash recovery
- a dependency-free HTTP control plane with structured errors

## Quick start

```bash
npm ci
npm test
npm run build
CHRONICLE_DATA_DIR=.chronicle node dist/server.js
```

The service listens on `http://localhost:8080`. Start an execution, lease commands to a worker, then report their outcome:

```bash
curl -sS -X POST http://localhost:8080/v1/executions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: checkout-1042' \
  -d '{"workflow":"order-fulfilment","input":{"orderId":"1042"}}'

curl -sS -X POST http://localhost:8080/v1/workers/payments-worker/leases
```

See [the architecture](docs/architecture.md), [failure semantics](docs/failure-semantics.md), and [threat model](docs/threat-model.md) before adapting it to production.

## Honest boundaries

ChronicleFlow is a reference implementation, not a hosted workflow service. The file adapter is durable for a single process on one filesystem. Multi-node operation requires a store that provides transactional compare-and-swap and indexed runnable-work queries. Authentication, transport encryption, tenant quotas, and external secret management belong at the deployment boundary and are deliberately not faked here.

## License

[MIT](LICENSE)
