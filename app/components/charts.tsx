"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMs, formatTime, formatUsd } from "../lib/format";

const axis = { stroke: "#7d8ca3", fontSize: 11 };
const grid = "#263244";
const tooltipStyle = {
  background: "#101722",
  border: "1px solid #2d3b50",
  borderRadius: 8,
  color: "#dbe5f2",
  fontSize: 12,
};

export interface TimePoint {
  bucketUs: number;
  spans: number;
  errors: number;
  p95LatencyMs: number;
  costUsd: number;
}

export function SpansAreaChart({ data }: { data: TimePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="spansFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#48b8ff" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#48b8ff" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucketUs" tickFormatter={(value: number) => formatTime(value).slice(0, 5)} {...axis} />
        <YAxis {...axis} allowDecimals={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(value) => formatTime(Number(value))}
          formatter={(value) => [Number(value), "spans"]}
        />
        <Area type="monotone" dataKey="spans" name="spans" stroke="#48b8ff" fill="url(#spansFill)" strokeWidth={2} />
        <Area type="monotone" dataKey="errors" name="errors" stroke="#ff6b7a" fill="#ff6b7a" fillOpacity={0.15} strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function LatencyLineChart({ data }: { data: TimePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucketUs" tickFormatter={(value: number) => formatTime(value).slice(0, 5)} {...axis} />
        <YAxis {...axis} unit=" ms" />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(value) => formatTime(Number(value))}
          formatter={(value) => [formatMs(Number(value)), "p95"] as [string, string]}
        />
        <Line type="monotone" dataKey="p95LatencyMs" stroke="#f6b85f" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function CostByUserChart({ data }: { data: { userId: string; costUsd: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 24, bottom: 0 }}>
        <CartesianGrid stroke={grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tickFormatter={(value: number) => formatUsd(value)} {...axis} />
        <YAxis type="category" dataKey="userId" width={84} {...axis} />
        <Tooltip contentStyle={tooltipStyle} formatter={(value) => [formatUsd(Number(value)), "cost"] as [string, string]} />
        <Bar dataKey="costUsd" fill="#8b7cff" radius={[0, 6, 6, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function EvalTrendChart({
  data,
  metrics,
}: {
  data: Record<string, number | string>[];
  metrics: string[];
}) {
  const colors = ["#48b8ff", "#ff6b7a", "#f6b85f", "#8b7cff", "#55d6a5"];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucketUs" tickFormatter={(value: number) => formatTime(value).slice(0, 5)} {...axis} />
        <YAxis domain={[0, 1]} {...axis} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(value) => formatTime(Number(value))}
          formatter={(value) => Number(value).toFixed(2)}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "#9aa9bd" }} />
        {metrics.map((metric, index) => (
          <Line
            key={metric}
            type="monotone"
            dataKey={metric}
            stroke={colors[index % colors.length]}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function DriftLineChart({
  data,
  apps,
  threshold,
}: {
  data: Record<string, number | string>[];
  apps: string[];
  threshold: number;
}) {
  const colors = ["#48b8ff", "#f6b85f", "#8b7cff", "#55d6a5", "#ff6b7a", "#e879f9"];
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
        <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="windowEndUs" tickFormatter={(value: number) => formatTime(value).slice(0, 5)} {...axis} />
        <YAxis domain={[0, "auto"]} {...axis} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(value) => formatTime(Number(value))}
          formatter={(value) => Number(value).toFixed(3)}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "#9aa9bd" }} />
        <ReferenceLine y={threshold} stroke="#ff6b7a" strokeDasharray="5 4" label={{ value: `PSI ${threshold}`, fill: "#ff6b7a", fontSize: 11 }} />
        {apps.map((app, index) => (
          <Line
            key={app}
            type="monotone"
            dataKey={app}
            stroke={colors[index % colors.length]}
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
