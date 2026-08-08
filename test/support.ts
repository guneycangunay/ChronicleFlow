import type { Clock, Execution, WorkflowDefinition } from "../src/domain.js";
import { ConflictError } from "../src/errors.js";
import type { ExecutionStore } from "../src/store.js";

export class MemoryStore implements ExecutionStore {
  private readonly executions = new Map<string, Execution>();

  public async create(execution: Execution): Promise<Execution> {
    const existing = [...this.executions.values()].find(
      (candidate) => candidate.idempotencyHash === execution.idempotencyHash,
    );
    if (existing) return structuredClone(existing);
    this.executions.set(execution.id, structuredClone(execution));
    return structuredClone(execution);
  }

  public async findByIdempotencyHash(hash: string): Promise<Execution | undefined> {
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.idempotencyHash === hash,
    );
    return execution ? structuredClone(execution) : undefined;
  }

  public async get(id: string): Promise<Execution | undefined> {
    const execution = this.executions.get(id);
    return execution ? structuredClone(execution) : undefined;
  }

  public async list(): Promise<Execution[]> {
    return [...this.executions.values()].map((execution) => structuredClone(execution));
  }

  public async save(execution: Execution, expectedRevision: number): Promise<Execution> {
    const current = this.executions.get(execution.id);
    if (!current || current.revision !== expectedRevision) {
      throw new ConflictError("stale revision");
    }
    const saved = structuredClone(execution);
    saved.revision = expectedRevision + 1;
    this.executions.set(saved.id, saved);
    return structuredClone(saved);
  }
}

export class FakeClock implements Clock {
  public constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {}

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export function workflow(
  steps: WorkflowDefinition["steps"] = [
    {
      name: "reserve",
      action: "inventory.reserve",
      compensation: "inventory.release",
      maxAttempts: 3,
      retryDelayMs: 1_000,
      timeoutMs: 5_000,
    },
    {
      name: "capture",
      action: "payment.capture",
      compensation: "payment.refund",
      maxAttempts: 3,
      retryDelayMs: 1_000,
      timeoutMs: 5_000,
    },
  ],
): WorkflowDefinition {
  return { name: "checkout", version: 1, steps };
}
