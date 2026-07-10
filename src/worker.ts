import type { Policy } from "./config";
import type { Logger } from "./logging";
import type { AlertEngine } from "./alerts/rules";
import type { Collector } from "./ingest/collector";
import type { EvalRunner } from "./eval/runner";
import type { DriftDetector } from "./drift/detector";

export interface WorkerDeps {
  collector: Collector;
  evalRunner: EvalRunner;
  driftDetector: DriftDetector;
  alertEngine: AlertEngine;
  policy: Policy;
  nowUs?: () => number;
  logger?: Logger;
}

export class Worker {
  private readonly deps: WorkerDeps;
  private readonly nowUs: () => number;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly running = new Set<string>();
  private nextDriftAt = 0;
  private stopped = false;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
    this.nowUs = deps.nowUs ?? (() => Date.now() * 1000);
  }

  start(): void {
    if (this.timers.length > 0) return;
    this.timers.push(setInterval(() => void this.flush(), 250));
    this.timers.push(setInterval(() => void this.runEval(), this.deps.policy.eval.intervalMs));
    this.timers.push(setInterval(() => void this.runAlerts(), this.deps.policy.alerts.intervalMs));
    this.timers.push(setInterval(() => void this.runDrift(), this.deps.policy.drift.intervalMs));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  async tick(nowUs = this.nowUs()): Promise<void> {
    await this.flush();
    await this.runEval(nowUs);
    await this.runDrift(nowUs);
    await this.runAlerts(nowUs);
  }

  private async guard(name: string, work: () => Promise<void>): Promise<void> {
    if (this.stopped || this.running.has(name)) return;
    this.running.add(name);
    try {
      await work();
    } catch (error) {
      this.deps.logger?.error(`worker ${name} failed`, { error: (error as Error).message });
    } finally {
      this.running.delete(name);
    }
  }

  private async flush(): Promise<void> {
    await this.guard("flush", async () => {
      await this.deps.collector.flush(false);
    });
  }

  private async runEval(nowUs = this.nowUs()): Promise<void> {
    await this.guard("eval", async () => {
      await this.deps.evalRunner.runOnce(nowUs);
    });
  }

  private async runDrift(nowUs = this.nowUs()): Promise<void> {
    if (nowUs < this.nextDriftAt) return;
    await this.guard("drift", async () => {
      this.nextDriftAt = nowUs + this.deps.policy.drift.intervalMs * 1000;
      await this.deps.driftDetector.run({ nowUs });
    });
  }

  private async runAlerts(nowUs = this.nowUs()): Promise<void> {
    await this.guard("alerts", async () => {
      await this.deps.alertEngine.evaluate(nowUs);
    });
  }
}
