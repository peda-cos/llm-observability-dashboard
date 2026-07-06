import { createHash, randomBytes } from "node:crypto";

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function isHexId(value: string, length: 16 | 32): boolean {
  return new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

export function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function promptHash(text: string): string {
  return hashHex(text.trim());
}

/** Deterministic trace-level sampling; independent of arrival order. */
export function sampleTrace(traceId: string, salt: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = createHash("sha256").update(`${salt}:${traceId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < rate;
}

export function shortHash(value: string, length = 12): string {
  return hashHex(value).slice(0, length);
}
