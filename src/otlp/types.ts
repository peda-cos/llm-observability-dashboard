import type { JsonValue } from "../types";

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: string;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpanEvent {
  timeUnixNano?: string | number;
  name?: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: { code?: number | string; message?: string };
  events?: OtlpSpanEvent[];
}

export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpExportTraceServiceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

export interface DecodedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, JsonValue>;
  events: { name: string; attributes: Record<string, JsonValue> }[];
  statusCode: 0 | 1 | 2;
  statusMessage: string | null;
  resource: Record<string, JsonValue>;
  scopeName: string | null;
}
