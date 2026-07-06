import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function resolveDbPath(): string {
  return process.env.OBS_DB ?? "./data/obs.db";
}

function schemaPath(): string {
  return process.env.OBS_SCHEMA_PATH ?? path.join(process.cwd(), "db", "sqlite", "schema.sql");
}

export function openDb(dbPath = resolveDbPath()): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(schemaPath(), "utf8"));
  return db;
}

export function closeDb(db: DatabaseSync): void {
  db.close();
}
