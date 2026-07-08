import type { EvalPolicy } from "../config";
import { newSpanId } from "../ids";
import type { Logger } from "../logging";
import { redact } from "../pii";
import type { SQLiteStore } from "../storage/sqliteStore";
import type { EvalRunRow, SpanRow, TriageRow } from "../types";
import type { EvalEngine } from "./engine";
import { metricPass } from "./engine";
import { expectedIdsFromAttributes } from "./metrics";

export interface EvalRunnerDeps {
  store: SQLiteStore;
  engine: EvalEngine;
  policy: EvalPolicy;
  nowUs?: () => number;
  id?: () => string;
  logger?: Logger;
}

export interface EvalRunResult {
  sampled: number;
  evaluated: number;
  evalSpans: number;
  piiHigh: number;
}

export class EvalRunner {
  private readonly deps: EvalRunnerDeps;
  private readonly nowUs: () => number;
  private readonly id: () => string;

  constructor(deps: EvalRunnerDeps) {
    this.deps = deps;
    this.nowUs = deps.nowUs ?? (() => Date.now() * 1000);
    this.id = deps.id ?? newSpanId;
  }

  runOnce(nowUs = this.nowUs()): Promise<EvalRunResult> {
    return this.runWindow(nowUs - this.deps.policy.windowMs, nowUs, nowUs);
  }

  async runWindow(startUs: number, endUs: number, nowUs: number): Promise<EvalRunResult> {
    const candidates = this.deps.store.evalCandidatesBetween(
      startUs,
      endUs,
      this.deps.policy.sampleRate,
      this.deps.policy.batchSize,
    );
    const rows: SpanRow[] = [];
    let evaluated = 0;
    let piiHigh = 0;

    for (const candidate of candidates) {
      if (!candidate.completionText) continue;
      let outputs;
      try {
        outputs = await this.deps.engine.evaluate({
          prompt: candidate.promptText,
          completion: candidate.completionText,
          retrieval: candidate.retrieval,
          expectedIds: expectedIdsFromAttributes(candidate.attributes),
        });
      } catch (error) {
        this.deps.logger?.error("eval failed for span", {
          spanId: candidate.spanId,
          error: (error as Error).message,
        });
        continue;
      }
      evaluated += 1;
      for (const [index, output] of outputs.entries()) {
        const pass = metricPass(output.metric, output.score, this.deps.policy);
        if (output.metric === "pii_leak" && output.score >= this.deps.policy.piiThreshold) {
          piiHigh += 1;
          const triage: TriageRow = {
            id: `triage:${candidate.spanId}`,
            spanId: candidate.spanId,
            traceId: candidate.traceId,
            score: output.score,
            reason: output.reason,
            excerpt: redact(candidate.completionText).slice(0, 240),
            status: "open",
            createdUs: nowUs,
            resolvedUs: null,
          };
          this.deps.store.insertTriage(triage);
        }
        const startUsEval = nowUs;
        rows.push({
          spanId: this.id(),
          traceId: candidate.traceId,
          parentSpanId: candidate.spanId,
          name: `eval.${output.metric}`,
          kind: "internal",
          startUs: startUsEval,
          endUs: startUsEval + 1000,
          latencyMs: 0.001,
          statusCode: 1,
          statusMessage: null,
          genAiSystem: "eval",
          requestModel: output.engine,
          responseModel: output.engine,
          responseId: null,
          operation: "eval",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          promptHash: null,
          appId: candidate.appId,
          userId: candidate.userId,
          sessionId: candidate.sessionId,
          environment: candidate.environment,
          instrumentationFamily: null,
          promptText: null,
          completionText: null,
          retrieval: null,
          attributes: {
            "eval.reason": output.reason,
            "eval.parent_trace_id": candidate.traceId,
          },
          pii: [],
          piiCompletion: false,
          sampledReason: "eval",
          ingestedAtUs: nowUs,
          isEval: true,
          evalName: output.metric,
          evalScore: output.score,
          evalPass: pass,
          evalEngine: output.engine,
        });
      }
    }

    if (rows.length > 0) this.deps.store.insertSpans(rows);
    const run: EvalRunRow = {
      id: `evalrun:${nowUs}:${startUs}:${endUs}`,
      startedUs: nowUs,
      finishedUs: this.nowUs(),
      windowStartUs: startUs,
      windowEndUs: endUs,
      sampled: candidates.length,
      evaluated,
      engine: this.deps.engine.name,
    };
    this.deps.store.insertEvalRun(run);
    return { sampled: candidates.length, evaluated, evalSpans: rows.length, piiHigh };
  }
}
