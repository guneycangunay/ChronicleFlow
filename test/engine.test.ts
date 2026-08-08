import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowEngine } from "../src/engine.js";
import { ConflictError, ValidationError } from "../src/errors.js";
import { FakeClock, MemoryStore, workflow } from "./support.js";

describe("WorkflowEngine", () => {
  it("deduplicates starts by workflow and idempotency key", async () => {
    const engine = new WorkflowEngine(new MemoryStore(), new FakeClock(), [workflow()]);

    const first = await engine.start("checkout", { orderId: "o-1" }, "request-1");
    const duplicate = await engine.start("checkout", { orderId: "different" }, "request-1");

    assert.equal(duplicate.id, first.id);
    assert.deepEqual(duplicate.input, { orderId: "o-1" });
  });

  it("dispatches steps in order and reaches succeeded", async () => {
    const engine = new WorkflowEngine(new MemoryStore(), new FakeClock(), [workflow()]);
    const execution = await engine.start("checkout", { orderId: "o-2" }, "request-2");

    const reserve = await engine.lease("worker-a");
    assert.equal(reserve?.command.operation, "inventory.reserve");
    await engine.complete(execution.id, reserve!.command.id, { succeeded: true });

    const capture = await engine.lease("worker-b");
    assert.equal(capture?.command.operation, "payment.capture");
    const completed = await engine.complete(execution.id, capture!.command.id, { succeeded: true });

    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.steps.map((step) => step.status), ["succeeded", "succeeded"]);
    assert.equal(await engine.lease("worker-a"), undefined);
  });

  it("redelivers the same command after a lease expires", async () => {
    const clock = new FakeClock();
    const engine = new WorkflowEngine(new MemoryStore(), clock, [workflow()]);
    await engine.start("checkout", {}, "request-3");

    const first = await engine.lease("worker-a", 1_000);
    clock.advance(1_001);
    const redelivery = await engine.lease("worker-b", 1_000);

    assert.equal(redelivery?.command.id, first?.command.id);
    assert.equal(redelivery?.command.attempt, 1);
    assert.equal(redelivery?.workerId, "worker-b");
  });

  it("respects retry delay and terminates after the retry budget", async () => {
    const clock = new FakeClock();
    const definition = workflow([
      {
        name: "charge",
        action: "payment.charge",
        maxAttempts: 2,
        retryDelayMs: 500,
        timeoutMs: 2_000,
      },
    ]);
    const engine = new WorkflowEngine(new MemoryStore(), clock, [definition]);
    const execution = await engine.start("checkout", {}, "request-4");

    const first = await engine.lease("worker");
    await engine.complete(execution.id, first!.command.id, { succeeded: false, error: "timeout" });
    assert.equal(await engine.lease("worker"), undefined);

    clock.advance(500);
    const retry = await engine.lease("worker");
    assert.equal(retry?.command.attempt, 2);
    assert.notEqual(retry?.command.id, first?.command.id);
    const failed = await engine.complete(execution.id, retry!.command.id, {
      succeeded: false,
      error: "declined",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[0]?.lastError, "declined");
  });

  it("compensates completed steps in reverse order", async () => {
    const definition = workflow([
      {
        name: "inventory",
        action: "inventory.reserve",
        compensation: "inventory.release",
        maxAttempts: 1,
        retryDelayMs: 0,
        timeoutMs: 1_000,
      },
      {
        name: "payment",
        action: "payment.capture",
        compensation: "payment.refund",
        maxAttempts: 1,
        retryDelayMs: 0,
        timeoutMs: 1_000,
      },
      {
        name: "shipment",
        action: "shipment.create",
        maxAttempts: 1,
        retryDelayMs: 0,
        timeoutMs: 1_000,
      },
    ]);
    const engine = new WorkflowEngine(new MemoryStore(), new FakeClock(), [definition]);
    const execution = await engine.start("checkout", {}, "request-5");

    for (let index = 0; index < 2; index += 1) {
      const lease = await engine.lease("worker");
      await engine.complete(execution.id, lease!.command.id, { succeeded: true });
    }
    const shipment = await engine.lease("worker");
    const compensating = await engine.complete(execution.id, shipment!.command.id, {
      succeeded: false,
      error: "carrier unavailable",
    });
    assert.equal(compensating.status, "compensating");

    const refund = await engine.lease("worker");
    assert.equal(refund?.command.operation, "payment.refund");
    assert.equal(refund?.command.phase, "compensation");
    await engine.complete(execution.id, refund!.command.id, { succeeded: true });

    const release = await engine.lease("worker");
    assert.equal(release?.command.operation, "inventory.release");
    const compensated = await engine.complete(execution.id, release!.command.id, {
      succeeded: true,
    });
    assert.equal(compensated.status, "compensated");
  });

  it("makes duplicate completion delivery a no-op", async () => {
    const engine = new WorkflowEngine(new MemoryStore(), new FakeClock(), [workflow()]);
    const execution = await engine.start("checkout", {}, "request-6");
    const lease = await engine.lease("worker");
    const first = await engine.complete(execution.id, lease!.command.id, { succeeded: true });
    const duplicate = await engine.complete(execution.id, lease!.command.id, { succeeded: true });

    assert.equal(duplicate.revision, first.revision);
    assert.equal(duplicate.cursor, first.cursor);
  });

  it("rejects a completion for an inactive command", async () => {
    const engine = new WorkflowEngine(new MemoryStore(), new FakeClock(), [workflow()]);
    const execution = await engine.start("checkout", {}, "request-7");

    await assert.rejects(
      engine.complete(execution.id, "fabricated", { succeeded: true }),
      ConflictError,
    );
  });

  it("validates definitions at registration", () => {
    assert.throws(
      () =>
        new WorkflowEngine(new MemoryStore(), new FakeClock(), [
          { name: "Bad Name", version: 1, steps: [] },
        ]),
      ValidationError,
    );
  });
});
