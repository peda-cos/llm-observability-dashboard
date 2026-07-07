import type { JsonValue } from "../types";
import { isHexId } from "../ids";
import { isRecord } from "../json";
import type {
  DecodedSpan,
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
  OtlpSpan,
} from "./types";

export class OtlpDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpDecodeError";
  }
}

const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];

export function decodeValue(value: OtlpAnyValue | null | undefined): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) return null;
  if ("stringValue" in value) return typeof value.stringValue === "string" ? value.stringValue : null;
  if ("boolValue" in value) return typeof value.boolValue === "boolean" ? value.boolValue : null;
  if ("intValue" in value) {
    const parsed = Number(value.intValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if ("doubleValue" in value) {
    return typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)
      ? value.doubleValue
      : null;
  }
  if ("arrayValue" in value) {
    const values = isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)
      ? value.arrayValue.values
      : [];
    return values.map((item) => decodeValue(item as OtlpAnyValue));
  }
  if ("kvlistValue" in value) {
    const values = isRecord(value.kvlistValue) && Array.isArray(value.kvlistValue.values)
      ? value.kvlistValue.values
      : [];
    return Object.fromEntries(
      values.map((item) => {
        const entry = item as OtlpKeyValue;
        return [entry.key, decodeValue(entry.value)];
      }),
    );
  }
  if ("bytesValue" in value) return typeof value.bytesValue === "string" ? value.bytesValue : null;
  return null;
}

export function attrsToObject(attributes: OtlpKeyValue[] | undefined): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const attribute of attributes ?? []) {
    if (!attribute || typeof attribute.key !== "string") continue;
    result[attribute.key] = decodeValue(attribute.value);
  }
  return result;
}

function parseNanos(value: string | number | bigint | undefined): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value >= 0n ? value : null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = BigInt(text);
  return parsed >= 0n && parsed <= 9_000_000_000_000_000_000n ? parsed : null;
}

function parseKind(value: OtlpSpan["kind"]): string {
  if (typeof value === "number") return SPAN_KINDS[value] ?? "unspecified";
  if (typeof value === "string") {
    const normalized = value.toLowerCase().replace(/^span_kind_/, "");
    return SPAN_KINDS.includes(normalized) ? normalized : "unspecified";
  }
  return "unspecified";
}

function parseStatus(value: OtlpSpan["status"]): { code: 0 | 1 | 2; message: string | null } {
  const message = typeof value?.message === "string" ? value.message : null;
  const raw = value?.code;
  if (raw === 2 || raw === "2" || raw === "ERROR" || raw === "STATUS_CODE_ERROR") {
    return { code: 2, message };
  }
  if (raw === 1 || raw === "1" || raw === "OK" || raw === "STATUS_CODE_OK") {
    return { code: 1, message };
  }
  return { code: 0, message };
}

export interface DecodeResult {
  spans: DecodedSpan[];
  rejected: number;
}

export function decodeExport(input: unknown): DecodeResult {
  if (!isRecord(input)) throw new OtlpDecodeError("OTLP payload must be a JSON object");
  const request = input as unknown as OtlpExportTraceServiceRequest;
  if (request.resourceSpans === undefined) {
    throw new OtlpDecodeError("OTLP payload is missing resourceSpans");
  }
  if (!Array.isArray(request.resourceSpans)) {
    throw new OtlpDecodeError("resourceSpans must be an array");
  }

  let rejected = 0;
  const spans: DecodedSpan[] = [];
  for (const resourceSpan of request.resourceSpans) {
    const resource = attrsToObject(resourceSpan.resource?.attributes);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      const scopeName = typeof scopeSpan.scope?.name === "string" ? scopeSpan.scope.name : null;
      for (const rawSpan of scopeSpan.spans ?? []) {
        const traceId = typeof rawSpan.traceId === "string" ? rawSpan.traceId.toLowerCase() : "";
        const spanId = typeof rawSpan.spanId === "string" ? rawSpan.spanId.toLowerCase() : "";
        const parentRaw =
          typeof rawSpan.parentSpanId === "string" ? rawSpan.parentSpanId.toLowerCase() : "";
        const startNs = parseNanos(rawSpan.startTimeUnixNano);
        const endNs = parseNanos(rawSpan.endTimeUnixNano);
        if (!isHexId(traceId, 32) || !isHexId(spanId, 16) || startNs === null || endNs === null) {
          rejected += 1;
          continue;
        }
        if (parentRaw && !isHexId(parentRaw, 16)) {
          rejected += 1;
          continue;
        }
        const status = parseStatus(rawSpan.status);
        spans.push({
          traceId,
          spanId,
          parentSpanId: parentRaw || null,
          name: typeof rawSpan.name === "string" && rawSpan.name.length > 0 ? rawSpan.name : "unknown",
          kind: parseKind(rawSpan.kind),
          startNs,
          endNs,
          attributes: attrsToObject(rawSpan.attributes),
          events: (rawSpan.events ?? []).map((event) => ({
            name: typeof event.name === "string" ? event.name : "unknown",
            attributes: attrsToObject(event.attributes),
          })),
          statusCode: status.code,
          statusMessage: status.message,
          resource,
          scopeName,
        });
      }
    }
  }
  return { spans, rejected };
}
