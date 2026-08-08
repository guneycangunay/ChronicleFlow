import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Execution } from "./domain.js";
import { ConflictError } from "./errors.js";

interface Snapshot {
  readonly checksum: string;
  readonly payload: Execution;
}

export interface ExecutionStore {
  create(execution: Execution): Promise<Execution>;
  findByIdempotencyHash(hash: string): Promise<Execution | undefined>;
  get(id: string): Promise<Execution | undefined>;
  list(): Promise<Execution[]>;
  save(execution: Execution, expectedRevision: number): Promise<Execution>;
}

export class JsonFileExecutionStore implements ExecutionStore {
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly directory: string) {}

  public async create(execution: Execution): Promise<Execution> {
    return this.exclusive(async () => {
      await this.ensureDirectory();
      const existing = await this.findByIdempotencyHashUnlocked(execution.idempotencyHash);
      if (existing) return existing;

      const target = this.filePath(execution.id);
      let handle;
      try {
        handle = await open(target, "wx", 0o600);
        await handle.writeFile(this.encode(execution), "utf8");
        await handle.sync();
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new ConflictError(`execution ${execution.id} already exists`);
        }
        throw error;
      } finally {
        await handle?.close();
      }

      return structuredClone(execution);
    });
  }

  public async findByIdempotencyHash(hash: string): Promise<Execution | undefined> {
    return this.exclusive(() => this.findByIdempotencyHashUnlocked(hash));
  }

  public async get(id: string): Promise<Execution | undefined> {
    return this.exclusive(() => this.readSnapshot(id));
  }

  public async list(): Promise<Execution[]> {
    return this.exclusive(() => this.listUnlocked());
  }

  public async save(execution: Execution, expectedRevision: number): Promise<Execution> {
    return this.exclusive(async () => {
      const current = await this.readSnapshot(execution.id);
      if (!current) throw new ConflictError(`execution ${execution.id} disappeared during update`);
      if (current.revision !== expectedRevision) {
        throw new ConflictError(
          `stale execution revision: expected ${expectedRevision}, found ${current.revision}`,
        );
      }

      const next = structuredClone(execution);
      next.revision = expectedRevision + 1;
      await this.writeAtomically(this.filePath(next.id), this.encode(next));
      return structuredClone(next);
    });
  }

  private async listUnlocked(): Promise<Execution[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    const executions: Execution[] = [];
    for (const name of names) {
      const execution = await this.readSnapshot(name.slice(0, -5));
      if (execution) executions.push(execution);
    }
    return executions;
  }

  private async findByIdempotencyHashUnlocked(hash: string): Promise<Execution | undefined> {
    const executions = await this.listUnlocked();
    return executions.find((execution) => execution.idempotencyHash === hash);
  }

  private async readSnapshot(id: string): Promise<Execution | undefined> {
    let source: string;
    try {
      source = await readFile(this.filePath(id), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }

    const snapshot = JSON.parse(source) as Snapshot;
    const actual = checksum(JSON.stringify(snapshot.payload));
    if (actual !== snapshot.checksum) {
      throw new Error(`snapshot checksum mismatch for execution ${id}`);
    }
    return structuredClone(snapshot.payload);
  }

  private encode(execution: Execution): string {
    const payload = structuredClone(execution);
    return `${JSON.stringify({ checksum: checksum(JSON.stringify(payload)), payload } satisfies Snapshot, null, 2)}\n`;
  }

  private async writeAtomically(target: string, contents: string): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private filePath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid execution identifier");
    return path.join(this.directory, `${id}.json`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
