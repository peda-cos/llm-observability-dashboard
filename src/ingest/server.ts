import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { Policy } from "../config";
import type { Logger } from "../logging";
import { OtlpDecodeError } from "../otlp/decode";
import type { IngestCounters } from "../types";
import type { Collector } from "./collector";

export interface IngestServerDeps {
  collector: Collector;
  policy: Policy;
  counters: IngestCounters;
  metrics: () => string;
  alertmanager?: (payload: unknown) => Promise<void>;
  logger?: Logger;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "payload too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
  });
  response.end(text);
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

export function createIngestServer(deps: IngestServerDeps) {
  const logger = deps.logger;
  return createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type,content-encoding");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        sendText(response, 200, deps.metrics(), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/traces") {
        const raw = await readBody(request, deps.policy.storage.maxBodyBytes);
        let body = raw;
        if (String(request.headers["content-encoding"] ?? "").toLowerCase().includes("gzip")) {
          try {
            body = gunzipSync(raw);
          } catch {
            throw new HttpError(400, "invalid gzip body");
          }
        }
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          throw new HttpError(400, "invalid JSON");
        }
        const result = await deps.collector.ingest(payload);
        logger?.info("accepted OTLP export", { ...result });
        sendJson(response, 200, {});
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/alertmanager") {
        if (!deps.alertmanager) {
          sendJson(response, 404, { error: "alertmanager webhook not configured" });
          return;
        }
        const raw = await readBody(request, deps.policy.storage.maxBodyBytes);
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8")) as unknown;
        } catch {
          throw new HttpError(400, "invalid JSON");
        }
        await deps.alertmanager(payload);
        sendJson(response, 200, { status: "ok" });
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof OtlpDecodeError || error instanceof HttpError) {
        const status = error instanceof HttpError ? error.status : 400;
        sendJson(response, status, { error: error.message });
        return;
      }
      logger?.error("ingest request failed", { error: (error as Error).message });
      sendJson(response, 500, { error: "internal error" });
    }
  });
}
