import type { SpanRecord, SpanRow } from "../src/types";

export function toRecord(row: SpanRow): SpanRecord {
  return {
    ...row,
    startNs: BigInt(row.startUs) * 1000n,
    endNs: BigInt(row.endUs) * 1000n,
  };
}
