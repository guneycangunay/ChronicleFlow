import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Execution } from "../src/domain.js";
import { ConflictError } from "../src/errors.js";
import { JsonFileExecutionStore } from "../src/store.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("JsonFileExecutionStore", () => {
  it("persists and reloads a checksummed snapshot", async () => {
    const directory = await testDirectory();
    const store = new JsonFileExecutionStore(directory);
    const source = executionFixture();

    await store.create(source);
    const reloaded = await new JsonFileExecutionStore(directory).get(source.id);

    assert.deepEqual(reloaded, source);
  });

  it("rejects stale compare-and-swap revisions", async () => {
    const store = new JsonFileExecutionStore(await testDirectory());
    const source = await store.create(executionFixture());
    const firstWriter = structuredClone(source);
    firstWriter.status = "succeeded";
    await store.save(firstWriter, 0);

    const staleWriter = structuredClone(source);
    staleWriter.status = "failed";
    await assert.rejects(store.save(staleWriter, 0), ConflictError);
  });

  it("detects snapshot corruption before returning state", async () => {
    const directory = await testDirectory();
    const store = new JsonFileExecutionStore(directory);
    const source = executionFixture();
    await store.create(source);
    const filename = path.join(directory, `${source.id}.json`);
    const snapshot = await readFile(filename, "utf8");
    await writeFile(filename, snapshot.replace("running", "failed"), "utf8");

    await assert.rejects(store.get(source.id), /checksum mismatch/);
  });
});

async function testDirectory(): Promise<string> {
  const directory = path.join(tmpdir(), `chronicleflow-${crypto.randomUUID()}`);
  createdDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function executionFixture(): Execution {
  return {
    id: crypto.randomUUID(),
    definition: {
      name: "checkout",
      version: 1,
      steps: [
        {
          name: "capture",
          action: "payment.capture",
          maxAttempts: 3,
          retryDelayMs: 100,
          timeoutMs: 1_000,
        },
      ],
    },
    input: { orderId: "o-1" },
    idempotencyHash: "hash",
    status: "running",
    cursor: 0,
    revision: 0,
    nextRunAt: "2026-01-01T00:00:00.000Z",
    steps: [{ status: "pending", attempts: 0, compensationAttempts: 0 }],
    processedCommandIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
