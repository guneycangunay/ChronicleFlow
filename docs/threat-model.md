# Threat model

## Assets and trust boundaries

The primary assets are workflow input, execution history, idempotency keys, and the authority to run or compensate an operation. HTTP callers, workers, the orchestration process, the snapshot directory, and downstream systems are separate trust boundaries.

| Threat | Current control | Production follow-up |
|---|---|---|
| Forged completion | Completion must match the active command | Authenticate workers and authorize operation scopes |
| Replay of completion | Bounded processed-command history makes duplicates no-ops | Persist a durable command-result ledger where the replay window is longer |
| Snapshot tampering | SHA-256 detects corruption; files are mode `0600` | Use authenticated storage, encryption at rest, and restricted service identity |
| Path traversal | Execution IDs are validated before path construction | Keep adapter-specific validation in every implementation |
| Resource exhaustion | 1 MiB request limit, bounded definitions and identifiers | Add tenant quotas, rate limits, and storage retention policies |
| Sensitive data disclosure | Structured errors hide internal exceptions | Redact workflow input in logs and encrypt selected payload fields |
| Rogue workflow/worker | Registration validates shape only | Add signed definitions, deployment approval, and workload identity |

## Non-goals of the reference server

The example server does not implement user authentication, TLS termination, tenant isolation, or secret injection. Those controls depend on the deployment environment. Exposing it directly to an untrusted network would be unsafe.

## Reporting

Please use GitHub's private vulnerability reporting for issues that could affect adopters. Do not include live credentials, personal data, or production payloads in a report.
