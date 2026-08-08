import { createHash, randomUUID } from "node:crypto";
import type {
  Clock,
  Completion,
  Execution,
  JsonValue,
  Lease,
  StepState,
  WorkCommand,
  WorkflowDefinition,
} from "./domain.js";
import { isTerminal, systemClock } from "./domain.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { ExecutionStore } from "./store.js";

const DEFAULT_LEASE_MS = 30_000;
const MAX_COMPLETION_HISTORY = 128;

export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  public constructor(
    private readonly store: ExecutionStore,
    private readonly clock: Clock = systemClock,
    definitions: readonly WorkflowDefinition[] = [],
  ) {
    for (const definition of definitions) this.register(definition);
  }

  public register(definition: WorkflowDefinition): void {
    validateDefinition(definition);
    const key = definition.name;
    const current = this.definitions.get(key);
    if (current && current.version >= definition.version) {
      throw new ConflictError(`workflow ${key} version must increase beyond ${current.version}`);
    }
    this.definitions.set(key, structuredClone(definition));
  }

  public async start(
    workflow: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<Execution> {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ValidationError("idempotency key must contain between 1 and 200 characters");
    }
    const definition = this.definitions.get(workflow);
    if (!definition) throw new NotFoundError(`workflow ${workflow}`);

    const idempotencyHash = sha256(`${workflow}\0${idempotencyKey}`);
    const existing = await this.store.findByIdempotencyHash(idempotencyHash);
    if (existing) return existing;

    const now = this.clock.now().toISOString();
    const execution: Execution = {
      id: randomUUID(),
      definition: structuredClone(definition),
      input: structuredClone(input),
      idempotencyHash,
      status: "running",
      cursor: 0,
      revision: 0,
      nextRunAt: now,
      steps: definition.steps.map((): StepState => ({
        status: "pending",
        attempts: 0,
        compensationAttempts: 0,
      })),
      processedCommandIds: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.store.create(execution);
  }

  public async get(id: string): Promise<Execution> {
    const execution = await this.store.get(id);
    if (!execution) throw new NotFoundError(`execution ${id}`);
    return execution;
  }

  public async lease(workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<Lease | undefined> {
    if (!workerId || workerId.length > 100) {
      throw new ValidationError("worker id must contain between 1 and 100 characters");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new ValidationError("lease duration must be between 1000 and 300000 milliseconds");
    }

    const now = this.clock.now();
    const candidates = (await this.store.list())
      .filter((execution) => !isTerminal(execution.status))
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));

    for (const candidate of candidates) {
      const current = await this.store.get(candidate.id);
      if (!current || isTerminal(current.status)) continue;
      if (new Date(current.nextRunAt) > now) continue;
      if (current.activeLease && new Date(current.activeLease.expiresAt) > now) continue;

      const expectedRevision = current.revision;
      const command = this.buildCommand(current);
      const lease: Lease = {
        workerId,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        command,
      };
      current.activeLease = lease;
      current.updatedAt = now.toISOString();

      try {
        const saved = await this.store.save(current, expectedRevision);
        return saved.activeLease;
      } catch (error) {
        if (error instanceof ConflictError) continue;
        throw error;
      }
    }
    return undefined;
  }

  public async complete(
    executionId: string,
    commandId: string,
    completion: Completion,
  ): Promise<Execution> {
    const execution = await this.get(executionId);
    if (execution.processedCommandIds.includes(commandId)) return execution;
    if (!execution.activeLease || execution.activeLease.command.id !== commandId) {
      throw new ConflictError("command is not active for this execution");
    }
    if (!completion.succeeded && (!completion.error || completion.error.length > 500)) {
      throw new ValidationError("a failed completion requires an error of at most 500 characters");
    }

    const expectedRevision = execution.revision;
    const now = this.clock.now();
    const command = execution.activeLease.command;
    execution.activeLease = undefined;
    execution.processedCommandIds.push(commandId);
    if (execution.processedCommandIds.length > MAX_COMPLETION_HISTORY) {
      execution.processedCommandIds.splice(0, execution.processedCommandIds.length - MAX_COMPLETION_HISTORY);
    }

    if (command.phase === "forward") {
      this.completeForward(execution, completion, now);
    } else {
      this.completeCompensation(execution, completion, now);
    }
    execution.updatedAt = now.toISOString();
    return this.store.save(execution, expectedRevision);
  }

  private buildCommand(execution: Execution): WorkCommand {
    const definition = execution.definition.steps[execution.cursor];
    const state = execution.steps[execution.cursor];
    if (!definition || !state) throw new Error("execution cursor is outside the workflow definition");

    const phase = execution.status === "compensating" ? "compensation" : "forward";
    if (!state.activeCommandId) {
      if (phase === "forward") {
        state.attempts += 1;
        state.status = "dispatched";
        state.activeCommandId = commandId(execution.id, phase, execution.cursor, state.attempts);
      } else {
        state.compensationAttempts += 1;
        state.status = "compensating";
        state.activeCommandId = commandId(
          execution.id,
          phase,
          execution.cursor,
          state.compensationAttempts,
        );
      }
    }

    const operation = phase === "forward" ? definition.action : definition.compensation;
    if (!operation) throw new Error(`step ${definition.name} has no compensation operation`);
    return {
      id: state.activeCommandId,
      executionId: execution.id,
      workflow: execution.definition.name,
      stepIndex: execution.cursor,
      stepName: definition.name,
      operation,
      phase,
      attempt: phase === "forward" ? state.attempts : state.compensationAttempts,
      timeoutMs: definition.timeoutMs,
      input: structuredClone(execution.input),
    };
  }

  private completeForward(execution: Execution, completion: Completion, now: Date): void {
    const step = execution.steps[execution.cursor];
    const definition = execution.definition.steps[execution.cursor];
    if (!step || !definition) throw new Error("execution cursor is outside the workflow definition");
    step.activeCommandId = undefined;

    if (completion.succeeded) {
      step.status = "succeeded";
      step.completedAt = now.toISOString();
      step.lastError = undefined;
      if (execution.cursor === execution.steps.length - 1) {
        execution.status = "succeeded";
        execution.nextRunAt = now.toISOString();
        return;
      }
      execution.cursor += 1;
      execution.nextRunAt = now.toISOString();
      return;
    }

    step.lastError = completion.error;
    if (step.attempts < definition.maxAttempts) {
      step.status = "pending";
      execution.nextRunAt = new Date(now.getTime() + definition.retryDelayMs).toISOString();
      return;
    }

    step.status = "failed";
    const compensationIndex = this.previousCompensableStep(execution, execution.cursor - 1);
    if (compensationIndex === undefined) {
      execution.status = "failed";
      execution.nextRunAt = now.toISOString();
      return;
    }
    execution.status = "compensating";
    execution.cursor = compensationIndex;
    execution.nextRunAt = now.toISOString();
  }

  private completeCompensation(execution: Execution, completion: Completion, now: Date): void {
    const step = execution.steps[execution.cursor];
    const definition = execution.definition.steps[execution.cursor];
    if (!step || !definition) throw new Error("execution cursor is outside the workflow definition");
    step.activeCommandId = undefined;

    if (!completion.succeeded) {
      step.lastError = completion.error;
      if (step.compensationAttempts < definition.maxAttempts) {
        step.status = "succeeded";
        execution.nextRunAt = new Date(now.getTime() + definition.retryDelayMs).toISOString();
        return;
      }
      step.status = "compensation_failed";
      execution.status = "compensation_failed";
      execution.nextRunAt = now.toISOString();
      return;
    }

    step.status = "compensated";
    step.completedAt = now.toISOString();
    step.lastError = undefined;
    const next = this.previousCompensableStep(execution, execution.cursor - 1);
    if (next === undefined) {
      execution.status = "compensated";
      execution.nextRunAt = now.toISOString();
      return;
    }
    execution.cursor = next;
    execution.nextRunAt = now.toISOString();
  }

  private previousCompensableStep(execution: Execution, from: number): number | undefined {
    for (let index = from; index >= 0; index -= 1) {
      const state = execution.steps[index];
      const definition = execution.definition.steps[index];
      if (state?.status === "succeeded" && definition?.compensation) return index;
    }
    return undefined;
  }
}

function validateDefinition(definition: WorkflowDefinition): void {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(definition.name)) {
    throw new ValidationError("workflow name must be a lowercase slug between 3 and 63 characters");
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new ValidationError("workflow version must be a positive integer");
  }
  if (definition.steps.length === 0 || definition.steps.length > 100) {
    throw new ValidationError("workflow must contain between 1 and 100 steps");
  }
  const names = new Set<string>();
  for (const step of definition.steps) {
    if (!step.name || names.has(step.name)) throw new ValidationError("step names must be unique and non-empty");
    names.add(step.name);
    if (!step.action) throw new ValidationError(`step ${step.name} requires an action`);
    if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 20) {
      throw new ValidationError(`step ${step.name} maxAttempts must be between 1 and 20`);
    }
    if (!Number.isInteger(step.retryDelayMs) || step.retryDelayMs < 0) {
      throw new ValidationError(`step ${step.name} retryDelayMs must be a non-negative integer`);
    }
    if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 300_000) {
      throw new ValidationError(`step ${step.name} timeoutMs must be between 100 and 300000`);
    }
  }
}

function commandId(
  executionId: string,
  phase: "forward" | "compensation",
  stepIndex: number,
  attempt: number,
): string {
  return `${executionId}:${phase}:${stepIndex}:${attempt}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
