import type { DriftPolicy } from "../config";
import type { Logger } from "../logging";
import type { SQLiteStore } from "../storage/sqliteStore";
import type { DriftRunRow } from "../types";
import { embed } from "./embed";
import { assign, kmeans } from "./kmeans";
import { psiFromCounts } from "./psi";

export interface DriftDetectorDeps {
  store: SQLiteStore;
  policy: DriftPolicy;
  nowUs?: () => number;
  embedder?: (text: string) => Float64Array;
  logger?: Logger;
}

export interface DriftRunOptions {
  nowUs?: number;
  appId?: string;
}

interface Sample {
  appId: string;
  text: string;
}

export class DriftDetector {
  private readonly deps: DriftDetectorDeps;
  private readonly nowUs: () => number;
  private readonly embedText: (text: string) => Float64Array;

  constructor(deps: DriftDetectorDeps) {
    this.deps = deps;
    this.nowUs = deps.nowUs ?? (() => Date.now() * 1000);
    this.embedText = deps.embedder ?? ((text: string) => embed(text));
  }

  async run(options: DriftRunOptions = {}): Promise<DriftRunRow[]> {
    const nowUs = options.nowUs ?? this.nowUs();
    const currentStart = nowUs - this.deps.policy.currentWindowMs * 1000;
    const baselineStart = currentStart - this.deps.policy.baselineWindowMs * 1000;
    const baseline = this.deps.store
      .promptSamples(baselineStart, currentStart)
      .map((sample) => ({ appId: sample.appId, text: sample.text }));
    const current = this.deps.store
      .promptSamples(currentStart, nowUs)
      .map((sample) => ({ appId: sample.appId, text: sample.text }));

    const apps = new Set<string>([...baseline, ...current].map((sample) => sample.appId));
    const targets = options.appId ? [options.appId] : [...apps, "__all__"];
    const results: DriftRunRow[] = [];
    for (const appId of targets) {
      const baselineSamples = appId === "__all__" ? baseline : baseline.filter((sample) => sample.appId === appId);
      const currentSamples = appId === "__all__" ? current : current.filter((sample) => sample.appId === appId);
      const run = this.compute(appId, baselineSamples, currentSamples, nowUs, baselineStart, currentStart);
      this.deps.store.insertDriftRun(run);
      results.push(run);
    }
    this.deps.logger?.info("drift run complete", {
      apps: results.length,
      alerts: results.filter((run) => run.alert).length,
    });
    return results;
  }

  private compute(
    appId: string,
    baseline: Sample[],
    current: Sample[],
    nowUs: number,
    baselineStart: number,
    currentStart: number,
  ): DriftRunRow {
    const detailBase = {
      baselineWindowStartUs: baselineStart,
      baselineWindowEndUs: currentStart,
      currentWindowStartUs: currentStart,
      currentWindowEndUs: nowUs,
    };
    const insufficient =
      baseline.length < this.deps.policy.minBaseline || current.length < this.deps.policy.minCurrent;
    if (insufficient) {
      return {
        id: `drift:${appId}:${nowUs}`,
        computedUs: nowUs,
        appId,
        windowStartUs: currentStart,
        windowEndUs: nowUs,
        psi: 0,
        kl: 0,
        nCurrent: current.length,
        nBaseline: baseline.length,
        threshold: this.deps.policy.psiThreshold,
        alert: false,
        status: "insufficient_data",
        detailJson: JSON.stringify({
          ...detailBase,
          reason: "insufficient samples",
          clusterProps: [],
        }),
      };
    }

    const baselineVectors = baseline.slice(0, 5000).map((sample) => this.embedText(sample.text));
    const currentVectors = current.slice(0, 5000).map((sample) => this.embedText(sample.text));
    const clusters = Math.max(2, Math.min(this.deps.policy.clusters, baselineVectors.length));
    const model = kmeans(baselineVectors, clusters);
    const baselineCounts = new Array<number>(model.centroids.length).fill(0);
    for (const vector of baselineVectors) baselineCounts[assign(vector, model.centroids)] += 1;
    const currentCounts = new Array<number>(model.centroids.length).fill(0);
    for (const vector of currentVectors) currentCounts[assign(vector, model.centroids)] += 1;
    const { psi, kl, baseProps, currProps } = psiFromCounts(baselineCounts, currentCounts);
    const alert = psi > this.deps.policy.psiThreshold;
    return {
      id: `drift:${appId}:${nowUs}`,
      computedUs: nowUs,
      appId,
      windowStartUs: currentStart,
      windowEndUs: nowUs,
      psi,
      kl,
      nCurrent: current.length,
      nBaseline: baseline.length,
      threshold: this.deps.policy.psiThreshold,
      alert,
      status: alert ? "alert" : "ok",
      detailJson: JSON.stringify({
        ...detailBase,
        clusters: model.centroids.length,
        embedder: "hash-128",
        clusterProps: baseProps.map((base, index) => ({ base, current: currProps[index] })),
      }),
    };
  }
}
