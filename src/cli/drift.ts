import { loadPolicy } from "../config";
import { DriftDetector } from "../drift/detector";
import { openDb } from "../storage/db";
import { SQLiteStore } from "../storage/sqliteStore";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const nowOption = option("now");
const nowUs = nowOption ? Math.floor(Date.parse(nowOption) * 1000) : Date.now() * 1000;
if (!Number.isFinite(nowUs)) {
  console.error("Invalid --now; use an ISO timestamp");
  process.exit(1);
}
const appId = option("app");
const db = openDb();
const store = new SQLiteStore(db);
try {
  const policy = loadPolicy();
  const detector = new DriftDetector({ store, policy: policy.drift, nowUs: () => nowUs });
  const runs = await detector.run({ nowUs, appId });
  console.log(JSON.stringify(runs, null, 2));
} finally {
  store.close();
}
