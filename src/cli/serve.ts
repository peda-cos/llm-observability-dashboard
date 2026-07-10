import { createObsService } from "../service";

const service = createObsService();
const address = await service.start();
console.log(`[obs] listening on ${address.url} (OTLP /v1/traces, /metrics, /api/alertmanager)`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await service.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
