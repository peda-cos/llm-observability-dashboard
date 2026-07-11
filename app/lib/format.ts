export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "0 ms";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function shortId(value: string, length = 8): string {
  return value.length > length ? value.slice(0, length) : value;
}

export function formatTime(us: number): string {
  return `${new Date(us / 1000).toISOString().slice(11, 19)}Z`;
}

export function formatDateTime(us: number): string {
  return new Date(us / 1000).toISOString().slice(0, 16).replace("T", " ");
}

export function relativeUs(us: number, nowUs: number): string {
  const seconds = Math.max(0, Math.round((nowUs - us) / 1_000_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
