export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(levelName = process.env.LOG_LEVEL ?? "info"): Logger {
  const threshold = ORDER[(levelName as LogLevel) in ORDER ? (levelName as LogLevel) : "info"];
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
