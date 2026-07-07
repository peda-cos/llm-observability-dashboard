import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { shortHash } from "../ids";

function dateParts(nowUs: number): { day: string; hour: string } {
  const date = new Date(nowUs / 1000);
  return {
    day: date.toISOString().slice(0, 10),
    hour: date.getUTCHours().toString().padStart(2, "0"),
  };
}

export class FileArchive {
  private readonly root: string;
  private readonly nowUs: () => number;

  constructor(directory: string, options: { nowUs?: () => number } = {}) {
    this.root = path.resolve(directory);
    this.nowUs = options.nowUs ?? (() => Date.now() * 1000);
  }

  async writeRaw(payload: unknown): Promise<string> {
    const now = this.nowUs();
    const { day, hour } = dateParts(now);
    const key = path.posix.join(
      "raw",
      `dt=${day}`,
      `hour=${hour}`,
      `${now}-${shortHash(JSON.stringify(payload))}.json.gz`,
    );
    const target = path.join(this.root, key);
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, gzipSync(JSON.stringify(payload)));
    renameSync(temporary, target);
    return key;
  }

  async read(key: string): Promise<unknown> {
    const target = path.resolve(this.root, key);
    if (!target.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Archive key escapes archive root: ${key}`);
    }
    return JSON.parse(gunzipSync(readFileSync(target)).toString("utf8")) as unknown;
  }

  list(day?: string): string[] {
    const rawRoot = path.join(this.root, "raw");
    if (!existsSync(rawRoot)) return [];
    const keys: string[] = [];
    for (const dayEntry of readdirSync(rawRoot, { withFileTypes: true })) {
      if (!dayEntry.isDirectory() || !dayEntry.name.startsWith("dt=")) continue;
      if (day && dayEntry.name !== `dt=${day}`) continue;
      const dayPath = path.join(rawRoot, dayEntry.name);
      for (const hourEntry of readdirSync(dayPath, { withFileTypes: true })) {
        if (!hourEntry.isDirectory()) continue;
        const hourPath = path.join(dayPath, hourEntry.name);
        for (const file of readdirSync(hourPath)) {
          if (file.endsWith(".json.gz")) {
            keys.push(path.posix.join("raw", dayEntry.name, hourEntry.name, file));
          }
        }
      }
    }
    return keys.sort();
  }

  cleanup(beforeMs: number): number {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const key of this.list()) {
      const target = path.join(this.root, key);
      if (statSync(target).mtimeMs < beforeMs) {
        unlinkSync(target);
        removed += 1;
      }
    }
    return removed;
  }
}
