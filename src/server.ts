import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import { URL } from "node:url";
import type { Completion, JsonValue, WorkflowDefinition } from "./domain.js";
import { WorkflowEngine } from "./engine.js";
import { ChronicleError, NotFoundError, ValidationError } from "./errors.js";
import { JsonFileExecutionStore } from "./store.js";

const port = integerFromEnvironment("PORT", 8080);
const dataDirectory = process.env["CHRONICLE_DATA_DIR"] ?? ".chronicle";
const engine = new WorkflowEngine(new JsonFileExecutionStore(dataDirectory), undefined, [
  orderFulfilmentDefinition(),
]);

const server = createServer(async (request, response) => {
  const startedAt = performance.now();
  const requestId = safeRequestId(request.headers["x-request-id"]);
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");

  try {
    await route(request, response);
  } catch (error) {
    writeError(response, error);
  } finally {
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        requestId,
        method: request.method,
        path: request.url,
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      })}\n`,
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", message: "chronicleflow ready", port, dataDirectory })}\n`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close((error) => {
      if (error) {
        process.stderr.write(`${JSON.stringify({ level: "error", message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://chronicle.local");

  if (method === "GET" && url.pathname === "/health/live") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/health/ready") {
    writeJson(response, 200, { status: "ready" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/executions") {
    const body = await readJson(request);
    const workflow = requiredString(body, "workflow");
    const input = (body["input"] ?? null) as JsonValue;
    const idempotencyKey = singleHeader(request, "idempotency-key");
    if (!idempotencyKey) throw new ValidationError("idempotency-key header is required");
    const execution = await engine.start(workflow, input, idempotencyKey);
    writeJson(response, 202, execution, { location: `/v1/executions/${execution.id}` });
    return;
  }

  const executionMatch = url.pathname.match(/^\/v1\/executions\/([0-9a-f-]{36})$/i);
  if (method === "GET" && executionMatch?.[1]) {
    writeJson(response, 200, await engine.get(executionMatch[1]));
    return;
  }

  const leaseMatch = url.pathname.match(/^\/v1\/workers\/([a-zA-Z0-9._-]{1,100})\/leases$/);
  if (method === "POST" && leaseMatch?.[1]) {
    const body = await readJson(request, true);
    const leaseMs = optionalInteger(body, "leaseMs");
    const lease = await engine.lease(leaseMatch[1], leaseMs);
    if (!lease) {
      response.statusCode = 204;
      response.end();
      return;
    }
    writeJson(response, 200, lease);
    return;
  }

  const completionMatch = url.pathname.match(
    /^\/v1\/executions\/([0-9a-f-]{36})\/commands\/(.+)\/complete$/i,
  );
  if (method === "POST" && completionMatch?.[1] && completionMatch[2]) {
    const body = await readJson(request);
    const succeeded = body["succeeded"];
    if (typeof succeeded !== "boolean") throw new ValidationError("succeeded must be a boolean");
    const error = body["error"];
    if (error !== undefined && typeof error !== "string") {
      throw new ValidationError("error must be a string");
    }
    const completion: Completion = { succeeded, error: error as string | undefined };
    const execution = await engine.complete(
      completionMatch[1],
      decodeURIComponent(completionMatch[2]),
      completion,
    );
    writeJson(response, 200, execution);
    return;
  }

  throw new NotFoundError("route");
}

async function readJson(
  request: IncomingMessage,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
    throw new ValidationError("content-type must be application/json");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1_048_576) throw new ValidationError("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (bytes === 0 && allowEmpty) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ValidationError("request body must be a valid JSON object");
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(`${JSON.stringify(body)}\n`);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof ChronicleError) {
    writeJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`${JSON.stringify({ level: "error", message })}\n`);
  writeJson(response, 500, {
    error: { code: "internal_error", message: "an unexpected error occurred" },
  });
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new ValidationError(`${field} must be an integer`);
  return value as number;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[a-zA-Z0-9._-]{1,100}$/.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

function integerFromEnvironment(name: string, fallback: number): number {
  const source = process.env[name];
  if (!source) return fallback;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function orderFulfilmentDefinition(): WorkflowDefinition {
  return {
    name: "order-fulfilment",
    version: 1,
    steps: [
    {
      name: "reserve-inventory",
      action: "inventory.reserve",
      compensation: "inventory.release",
      maxAttempts: 3,
      retryDelayMs: 1_000,
      timeoutMs: 5_000,
    },
    {
      name: "authorize-payment",
      action: "payment.authorize",
      compensation: "payment.void",
      maxAttempts: 3,
      retryDelayMs: 2_000,
      timeoutMs: 10_000,
    },
    {
      name: "create-shipment",
      action: "shipping.create",
      maxAttempts: 4,
      retryDelayMs: 2_000,
      timeoutMs: 15_000,
    },
    ],
  };
}
