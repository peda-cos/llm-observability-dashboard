import type { Policy, Pricing } from "../config";
import type { Logger } from "../logging";
import { decodeExport } from "../otlp/decode";
import { normalizeSpans, toSpanRow } from "../otlp/normalize";
import type { SQLiteStore } from "../storage/sqliteStore";
import type { IngestCounters, SpanRecord, SpanRow } from "../types";
import type { FileArchive } from "./archive";
import type { ClickHouseExporter } from "./clickhouseExporter";
import type { SamplingDecision, TailSampler } from "./tailSampler";

export interface CollectorDeps {
  store: SQLiteStore;
  archive: FileArchive;
  sampler: TailSampler;
  policy: Policy;
  pricing: Pricing;
  counters: IngestCounters;
  captureContent?: boolean;
  clickhouse?: ClickHouseExporter;
  nowUs?: () => number;
  logger?: Logger;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  traces: number;
}

export class Collector {
  private readonly deps: CollectorDeps;
  private readonly nowUs: () => number;

  constructor(deps: CollectorDeps) {
    this.deps = deps;
    this.nowUs = deps.nowUs ?? (() => Date.now() * 1000);
  }

  async ingest(payload: unknown): Promise<IngestResult> {
    const decoded = decodeExport(payload);
    const { spans } = normalizeSpans(decoded.spans, {
      pricing: this.deps.pricing,
      captureContent: this.deps.captureContent ?? true,
      maxContentChars: this.deps.policy.storage.maxContentChars,
      nowUs: this.nowUs(),
    });
    this.deps.counters.offered += spans.length;
    this.deps.counters.rejected += decoded.rejected;

    try {
      await this.deps.archive.writeRaw(payload);
    } catch (error) {
      this.deps.logger?.error("archive write failed", { error: (error as Error).message });
    }

    this.deps.sampler.offer(spans);
    const decisions = this.deps.sampler.flushExpired(this.nowUs() / 1000);
    await this.persist(decisions);
    return {
      accepted: spans.length,
      rejected: decoded.rejected,
      traces: new Set(spans.map((span) => span.traceId)).size,
    };
  }

  async flush(force = false): Promise<void> {
    const decisions = this.deps.sampler.flushExpired(this.nowUs() / 1000, force);
    await this.persist(decisions);
  }

  pendingTraces(): number {
    return this.deps.sampler.pendingTraces();
  }

  pendingSpans(): number {
    return this.deps.sampler.pendingSpans();
  }

  private async persist(decisions: SamplingDecision[]): Promise<void> {
    if (decisions.length === 0) return;
    const keptRows: SpanRow[] = [];
    for (const decision of decisions) {
      this.deps.counters.byReason[decision.reason] =
        (this.deps.counters.byReason[decision.reason] ?? 0) + decision.spans.length;
      if (!decision.keep) {
        this.deps.counters.dropped += decision.spans.length;
        continue;
      }
      for (const span of decision.spans) {
        keptRows.push(toSpanRow(this.withReason(span, decision.reason)));
      }
    }
    if (keptRows.length === 0) return;
    this.deps.store.insertSpans(keptRows);
    this.deps.counters.kept += keptRows.length;
    if (this.deps.clickhouse) {
      try {
        await this.deps.clickhouse.insert(keptRows);
      } catch (error) {
        this.deps.logger?.error("clickhouse export failed", { error: (error as Error).message });
      }
    }
  }

  private withReason(span: SpanRecord, reason: string): SpanRecord {
    return { ...span, sampledReason: reason };
  }
}
