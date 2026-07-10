import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createLogger, type Logger } from "./logging";
import { loadPolicy, loadPricing, type DeepPartial, type Policy, type Pricing } from "./config";
import { piiJudgeFromEnv } from "./eval/judge";
import { LocalEvalEngine } from "./eval/engine";
import { EvalRunner } from "./eval/runner";
import { DriftDetector } from "./drift/detector";
import { Dispatcher } from "./alerts/dispatch";
import { AlertEngine } from "./alerts/rules";
import { handleAlertmanagerWebhook } from "./alerts/alertmanager";
import { renderMetrics } from "./alerts/prometheus";
import { FileArchive } from "./ingest/archive";
import { ClickHouseExporter } from "./ingest/clickhouseExporter";
import { Collector } from "./ingest/collector";
import { createIngestServer } from "./ingest/server";
import { TailSampler } from "./ingest/tailSampler";
import { openDb } from "./storage/db";
import { SQLiteStore } from "./storage/sqliteStore";
import { emptyIngestCounters, type IngestCounters } from "./types";
import { Worker } from "./worker";

export interface ObsServiceOptions {
  dbPath?: string;
  archiveDir?: string;
  policyOverrides?: DeepPartial<Policy>;
  env?: Record<string, string | undefined>;
  nowUs?: () => number;
  enableWorker?: boolean;
  port?: number;
  host?: string;
  logger?: Logger;
}

export interface ObsService {
  policy: Policy;
  pricing: Pricing;
  store: SQLiteStore;
  collector: Collector;
  worker: Worker | null;
  server: Server;
  counters: IngestCounters;
  start: () => Promise<{ port: number; url: string }>;
  close: () => Promise<void>;
}

export function createObsService(options: ObsServiceOptions = {}): ObsService {
  const env = { ...process.env, ...(options.env ?? {}) };
  const logger = options.logger ?? createLogger(env.LOG_LEVEL);
  const nowUs = options.nowUs ?? (() => Date.now() * 1000);
  const policy = loadPolicy(env.POLICY_PATH, options.policyOverrides);
  const pricing = loadPricing(env.PRICING_PATH);
  const dbPath = options.dbPath ?? env.OBS_DB ?? "./data/obs.db";
  const archiveDir = options.archiveDir ?? env.ARCHIVE_DIR ?? "./data/archive";
  const store = new SQLiteStore(openDb(dbPath), { evalSalt: "eval" });
  const counters = emptyIngestCounters();
  const archive = new FileArchive(archiveDir, { nowUs });
  const sampler = new TailSampler(policy.sampling, { now: () => nowUs() / 1000 });
  const clickhouse = env.CLICKHOUSE_URL
    ? new ClickHouseExporter({
        url: env.CLICKHOUSE_URL,
        database: env.CLICKHOUSE_DATABASE ?? "observability",
        username: env.CLICKHOUSE_USER || undefined,
        password: env.CLICKHOUSE_PASSWORD || undefined,
      })
    : undefined;
  const collector = new Collector({
    store,
    archive,
    sampler,
    policy,
    pricing,
    counters,
    captureContent: env.CAPTURE_CONTENT !== "0",
    clickhouse,
    nowUs,
    logger,
  });
  const engine = new LocalEvalEngine(piiJudgeFromEnv(env));
  const evalRunner = new EvalRunner({
    store,
    engine,
    policy: policy.eval,
    nowUs,
    logger,
  });
  const driftDetector = new DriftDetector({
    store,
    policy: policy.drift,
    nowUs,
    logger,
  });
  const dispatcher = new Dispatcher({
    store,
    slackUrl: env.SLACK_WEBHOOK_URL || undefined,
    pagerDutyKey: env.PAGERDUTY_ROUTING_KEY || undefined,
    pagerDutyUrl: env.PAGERDUTY_URL || undefined,
    nowUs,
    logger,
  });
  const alertEngine = new AlertEngine({ store, policy, dispatcher, nowUs, logger });
  const server = createIngestServer({
    collector,
    policy,
    counters,
    metrics: () => renderMetrics(store, counters, nowUs()),
    alertmanager: async (payload) => {
      await handleAlertmanagerWebhook(payload, { store, dispatcher, nowUs });
    },
    logger,
  });
  const worker =
    options.enableWorker === false
      ? null
      : new Worker({ collector, evalRunner, driftDetector, alertEngine, policy, nowUs, logger });
  worker?.start();

  let closed = false;
  return {
    policy,
    pricing,
    store,
    collector,
    worker,
    server,
    counters,
    start: async () => {
      const port = options.port ?? Number(env.OBS_PORT ?? 4318);
      const host = options.host ?? env.HOST ?? "127.0.0.1";
      const listening = Promise.withResolvers<void>();
      server.once("error", listening.reject);
      server.listen(port, host, () => {
        server.off("error", listening.reject);
        listening.resolve();
      });
      await listening.promise;
      const address = server.address() as AddressInfo;
      return { port: address.port, url: `http://${host}:${address.port}` };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      worker?.stop();
      await collector.flush(true);
      const closedServer = Promise.withResolvers<void>();
      if (!server.listening) {
        closedServer.resolve();
      } else {
        server.close(() => closedServer.resolve());
      }
      await closedServer.promise;
      store.close();
    },
  };
}
