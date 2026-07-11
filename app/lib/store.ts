import { openDb } from "../../src/storage/db";
import { SQLiteStore } from "../../src/storage/sqliteStore";

const globalForStore = globalThis as typeof globalThis & { __obsStore?: SQLiteStore };

export function getStore(): SQLiteStore {
  if (!globalForStore.__obsStore) {
    globalForStore.__obsStore = new SQLiteStore(
      openDb(process.env.OBS_DB ?? "./data/obs.db"),
      { evalSalt: "eval" },
    );
  }
  return globalForStore.__obsStore;
}
