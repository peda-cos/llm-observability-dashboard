import { sampleTrace } from "../ids";
import type { SamplingPolicy } from "../config";
import type { SpanRecord } from "../types";

export interface SamplingDecision {
  traceId: string;
  spans: SpanRecord[];
  keep: boolean;
  reason: "error" | "pii" | "success_sample" | "dropped" | "forced";
}

function isError(span: SpanRecord): boolean {
  if (span.statusCode === 2) return true;
  if (span.attributes["error.type"] !== undefined) return true;
  const status = span.attributes["http.response.status_code"];
  return typeof status === "number" && status >= 500;
}

export class TailSampler {
  private readonly policy: SamplingPolicy;
  private readonly now: () => number;
  private readonly pending = new Map<string, { spans: SpanRecord[]; deadlineMs: number }>();

  constructor(policy: SamplingPolicy, options: { now?: () => number } = {}) {
    this.policy = policy;
    this.now = options.now ?? Date.now;
  }

  offer(spans: SpanRecord[]): void {
    for (const span of spans) {
      const current = this.pending.get(span.traceId);
      if (current) {
        current.spans.push(span);
      } else {
        this.pending.set(span.traceId, {
          spans: [span],
          deadlineMs: this.now() + this.policy.decisionWaitMs,
        });
      }
    }
  }

  flushExpired(nowMs = this.now(), force = false): SamplingDecision[] {
    const decisions: SamplingDecision[] = [];
    for (const [traceId, trace] of this.pending.entries()) {
      if (!force && trace.deadlineMs > nowMs) continue;
      const hasError = this.policy.keepErrorTraces && trace.spans.some(isError);
      const hasPii = this.policy.keepPiiTraces && trace.spans.some((span) => span.pii.length > 0);
      let keep: boolean;
      let reason: SamplingDecision["reason"];
      if (hasError) {
        keep = true;
        reason = "error";
      } else if (hasPii) {
        keep = true;
        reason = "pii";
      } else if (sampleTrace(traceId, this.policy.salt, this.policy.successRate)) {
        keep = true;
        reason = "success_sample";
      } else {
        keep = false;
        reason = force ? "forced" : "dropped";
      }
      decisions.push({ traceId, spans: trace.spans, keep, reason });
      this.pending.delete(traceId);
    }
    return decisions;
  }

  pendingTraces(): number {
    return this.pending.size;
  }

  pendingSpans(): number {
    let count = 0;
    for (const trace of this.pending.values()) count += trace.spans.length;
    return count;
  }
}
