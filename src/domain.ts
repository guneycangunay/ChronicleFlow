export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface WorkflowStep {
  readonly name: string;
  readonly action: string;
  readonly compensation?: string | undefined;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly timeoutMs: number;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly version: number;
  readonly steps: readonly WorkflowStep[];
}

export type ExecutionStatus =
  | "running"
  | "compensating"
  | "succeeded"
  | "failed"
  | "compensated"
  | "compensation_failed";

export type StepStatus =
  | "pending"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "compensating"
  | "compensated"
  | "compensation_failed";

export interface StepState {
  status: StepStatus;
  attempts: number;
  compensationAttempts: number;
  activeCommandId?: string | undefined;
  lastError?: string | undefined;
  completedAt?: string | undefined;
}

export type CommandPhase = "forward" | "compensation";

export interface WorkCommand {
  readonly id: string;
  readonly executionId: string;
  readonly workflow: string;
  readonly stepIndex: number;
  readonly stepName: string;
  readonly operation: string;
  readonly phase: CommandPhase;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly input: JsonValue;
}

export interface Lease {
  readonly workerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly command: WorkCommand;
}

export interface Execution {
  readonly id: string;
  readonly definition: WorkflowDefinition;
  readonly input: JsonValue;
  readonly idempotencyHash: string;
  status: ExecutionStatus;
  cursor: number;
  revision: number;
  nextRunAt: string;
  activeLease?: Lease | undefined;
  readonly steps: StepState[];
  readonly processedCommandIds: string[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface Completion {
  readonly succeeded: boolean;
  readonly error?: string | undefined;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function isTerminal(status: ExecutionStatus): boolean {
  return ["succeeded", "failed", "compensated", "compensation_failed"].includes(status);
}
