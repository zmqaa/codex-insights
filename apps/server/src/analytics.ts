import { createHash } from "node:crypto";
import { addUsage, ZERO_USAGE, type ScanResult, type SessionSummary, type TimeRange, type TokenUsage, type UsagePoint } from "@codex-insight/core";
import { addApiPriceEstimates } from "./pricing.js";

export type RangeQuery = { range?: string; since?: string; until?: string };
export type RangeBounds = { start?: number; end?: number; label: TimeRange };

function parseBound(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

export function rangeBounds(query: RangeQuery, now = new Date()): RangeBounds {
  const selected = query.range;
  if (selected === "today") {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { start, end: now.getTime(), label: "today" };
  }
  if (selected === "7d" || selected === "30d") {
    const days = selected === "7d" ? 7 : 30;
    return { start: now.getTime() - days * 24 * 60 * 60 * 1000, end: now.getTime(), label: selected };
  }
  if (selected === "custom") return { start: parseBound(query.since), end: parseBound(query.until), label: "custom" };
  return { label: "all" };
}

export function projectName(projectPath?: string): string {
  if (!projectPath) return "Unknown project";
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").at(-1) || "Unknown project";
}

export function projectKey(projectPath?: string): string {
  if (!projectPath) return "unknown";
  const canonical = process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 20);
}

function empty(): TokenUsage { return { ...ZERO_USAGE }; }
function inBounds(point: UsagePoint, bounds: RangeBounds): boolean {
  if (!point.timestamp) return bounds.label === "all";
  const time = Date.parse(point.timestamp);
  return (bounds.start === undefined || time >= bounds.start) && (bounds.end === undefined || time <= bounds.end);
}
function dayKey(timestamp?: string): string | undefined {
  if (!timestamp) return undefined;
  const time = new Date(timestamp);
  return Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 10) : undefined;
}
function addTo(map: Map<string, TokenUsage>, key: string, usage: TokenUsage): void {
  map.set(key, addUsage(map.get(key) ?? empty(), usage));
}

export function summarizeRange(scan: ScanResult, query: RangeQuery = {}, now = new Date()) {
  const bounds = rangeBounds(query, now);
  const total = empty();
  const days = new Map<string, TokenUsage>();
  const projects = new Map<string, { name: string; usage: TokenUsage; sessions: Set<string> }>();
  const models = new Map<string, { usage: TokenUsage; sessions: Set<string> }>();
  const warnings = new Set(scan.warnings);

  for (const session of scan.sessions) {
    session.warnings.forEach((warning) => warnings.add(warning));
    const included = bounds.label === "all" ? session.timeline : session.timeline.filter((point) => inBounds(point, bounds));
    if (session.timeline.some((point) => !point.timestamp && Object.values(point.delta).some((value) => value > 0))) {
      warnings.add(bounds.label === "all"
        ? "Some snapshots have no timestamp; they count toward all-time totals but cannot be placed on the daily chart"
        : "Some snapshots have no timestamp and are excluded from date-filtered totals");
    }
    const selectedUsage = bounds.label === "all" ? session.usage : included.reduce((usage, point) => addUsage(usage, point.delta), empty());
    Object.assign(total, addUsage(total, selectedUsage));

    const pKey = projectKey(session.projectPath);
    const p = projects.get(pKey) ?? { name: projectName(session.projectPath), usage: empty(), sessions: new Set<string>() };
    p.usage = addUsage(p.usage, selectedUsage);
    if (Object.values(selectedUsage).some((value) => value > 0) || session.timeline.some((point) => inBounds(point, bounds))) p.sessions.add(session.id);
    projects.set(pKey, p);

    if (bounds.label === "all") {
      for (const [model, usage] of Object.entries(session.perModel)) {
        const m = models.get(model) ?? { usage: empty(), sessions: new Set<string>() };
        m.usage = addUsage(m.usage, usage);
        if (Object.values(usage).some((value) => value > 0)) m.sessions.add(session.id);
        models.set(model, m);
      }
    } else {
      for (const point of included) {
        const model = point.model ?? (session.modelNames.length > 1 ? "Mixed / unknown" : session.modelNames[0] ?? "Unknown");
        const m = models.get(model) ?? { usage: empty(), sessions: new Set<string>() };
        m.usage = addUsage(m.usage, point.delta);
        if (Object.values(point.delta).some((value) => value > 0)) m.sessions.add(session.id);
        models.set(model, m);
      }
    }
    for (const point of included) {
      const key = dayKey(point.timestamp);
      if (key) addTo(days, key, point.delta);
    }
  }

  const pricedModelSummary = addApiPriceEstimates([...models.entries()].map(([name, item]) => ({
    name, ...item.usage, sessionCount: item.sessions.size,
  })).sort((a, b) => b.totalTokens - a.totalTokens));

  return {
    range: bounds.label,
    since: bounds.start === undefined ? undefined : new Date(bounds.start).toISOString(),
    until: bounds.end === undefined ? undefined : new Date(bounds.end).toISOString(),
    usage: total,
    cacheHitRate: total.inputTokens === 0 ? null : total.cachedInputTokens / total.inputTokens * 100,
    daily: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, usage]) => ({ date, ...usage })),
    projects: [...projects.entries()].map(([id, item]) => ({ id, name: item.name, ...item.usage, sessionCount: item.sessions.size })).sort((a, b) => b.totalTokens - a.totalTokens),
    models: pricedModelSummary.models,
    apiCost: pricedModelSummary.apiCost,
    warnings: [...warnings],
  };
}

export function sessionDto(session: SessionSummary, includePath = false) {
  const modelNames = session.modelNames;
  return {
    id: session.id,
    title: session.title,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    projectKey: projectKey(session.projectPath),
    projectName: projectName(session.projectPath),
    modelNames,
    modelLabel: modelNames.length > 1 ? "Mixed models" : modelNames[0] ?? "Unknown",
    usage: session.usage,
    cacheHitRate: session.cacheHitRate,
    warnings: session.warnings,
    confidence: session.confidence,
    isUpdating: session.isUpdating,
    eventCount: session.eventCount,
    ...(includePath ? { projectPath: session.projectPath, logPaths: session.logPaths ?? [] } : {}),
  };
}

export function inDateRange(session: SessionSummary, query: RangeQuery, now = new Date()): boolean {
  const bounds = rangeBounds(query, now);
  if (bounds.label === "all") return true;
  if (!session.updatedAt) return false;
  const time = Date.parse(session.updatedAt);
  return (bounds.start === undefined || time >= bounds.start) && (bounds.end === undefined || time <= bounds.end);
}

export function safeSortUsage(a: SessionSummary, b: SessionSummary, sort: string): number {
  if (sort === "total") return b.usage.totalTokens - a.usage.totalTokens;
  if (sort === "output") return b.usage.outputTokens - a.usage.outputTokens;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

