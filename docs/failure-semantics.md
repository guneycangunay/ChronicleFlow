# Failure semantics

The public API distinguishes delivery failures from reported business failures. That distinction prevents a lost HTTP response from spending a retry attempt.

| Event | State change | Operator expectation |
|---|---|---|
| Worker never acknowledges a lease | Lease expires; identical command is redelivered | Worker deduplicates by command ID |
| Worker reports a retryable or terminal error | Attempt is consumed; engine applies the configured retry budget | Error is retained on the step |
| Final forward attempt fails | Prior compensable steps are scheduled in reverse order | Compensation is a business action, not a rollback |
| Compensation exhausts its retries | Execution becomes `compensation_failed` | Human or automated reconciliation is required |
| Duplicate completion arrives | Previously processed command is returned without a new revision | Client may safely retry after a lost response |
| Stale engine writer persists | Store rejects the expected revision | Caller reloads before attempting another transition |
| Snapshot checksum differs | Read fails closed | Restore or reconcile the damaged execution |

## Worker transaction pattern

For a command such as `payment.capture`, the worker should atomically record the command ID with the resulting payment record. On redelivery it returns the stored result. Calling a provider and only then storing the command ID leaves a crash window; when the provider supports idempotency, forward the ChronicleFlow command ID to close that window.

## Compensation caveat

Compensation is not guaranteed to restore the world to its original state. Inventory might have been observed as reserved, a refund may settle later, or a shipment may already be in transit. Compensation handlers should be explicit, observable business operations with their own retry and reconciliation strategy.
