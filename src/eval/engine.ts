import type { EvalPolicy } from "../config";
import type { RetrievalDoc } from "../types";
import {
  answerRelevance,
  contextPrecision,
  contextRecall,
  faithfulness,
  toxicity,
  type EvalMetric,
  type MetricResult,
} from "./metrics";
import { LocalPiiJudge, type PiiJudge } from "./judge";

export interface EvalInput {
  prompt: string | null;
  completion: string;
  retrieval: RetrievalDoc[] | null;
  expectedIds: string[] | null;
}

export interface EvalOutput {
  metric: EvalMetric;
  score: number;
  reason: string;
  engine: string;
}

export interface EvalEngine {
  readonly name: string;
  evaluate(input: EvalInput): Promise<EvalOutput[]>;
}

export class LocalEvalEngine implements EvalEngine {
  readonly name = "local-v1";
  private readonly judge: PiiJudge;
  private readonly fallback = new LocalPiiJudge();

  constructor(judge: PiiJudge = new LocalPiiJudge()) {
    this.judge = judge;
  }

  async evaluate(input: EvalInput): Promise<EvalOutput[]> {
    const outputs: EvalOutput[] = [];
    const push = (metric: EvalMetric, result: MetricResult | null, engine = this.name) => {
      if (result) outputs.push({ metric, ...result, engine });
    };
    push("faithfulness", faithfulness(input.completion, input.retrieval));
    push("answer_relevance", answerRelevance(input.prompt ?? "", input.completion));
    push("toxicity", toxicity(input.completion));
    try {
      const pii = await this.judge.score({ prompt: input.prompt, completion: input.completion });
      push("pii_leak", pii, this.name);
    } catch {
      const pii = await this.fallback.score({ prompt: input.prompt, completion: input.completion });
      push("pii_leak", { ...pii, reason: `judge fallback: ${pii.reason}` }, `${this.name}+pii-fallback`);
    }
    push("context_precision", contextPrecision(input.retrieval, input.expectedIds));
    push("context_recall", contextRecall(input.retrieval, input.expectedIds));
    return outputs;
  }
}

export function metricPass(metric: EvalMetric, score: number, policy: EvalPolicy): boolean {
  switch (metric) {
    case "faithfulness":
      return score >= policy.faithfulnessThreshold;
    case "toxicity":
      return score <= policy.toxicityThreshold;
    case "answer_relevance":
      return score >= policy.relevanceThreshold;
    case "pii_leak":
      return score < policy.piiThreshold;
    case "context_precision":
    case "context_recall":
      return score >= policy.contextThreshold;
  }
}
