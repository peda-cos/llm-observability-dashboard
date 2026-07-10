import { buildFamilyTrace, FAMILIES, type Family } from "../sdk/families";

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const family = (option("family", "openai") ?? "openai") as Family;
const url = option("url", "http://127.0.0.1:4318/v1/traces");
if (!FAMILIES.includes(family)) {
  console.error(`Unknown family ${family}; choose ${FAMILIES.join(", ")}`);
  process.exit(1);
}
if (!url) {
  console.error("Missing --url");
  process.exit(1);
}

const payload = buildFamilyTrace(family, {
  appId: "emit-demo",
  userId: "u_emit",
  sessionId: "s_emit",
  prompt: "How do I request a refund?",
  completion: "Refunds are available within 30 days.",
});
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
console.log(`[emit] ${family} -> ${url}: HTTP ${response.status} ${await response.text()}`);
if (!response.ok) process.exit(1);
