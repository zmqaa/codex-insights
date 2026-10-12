import type { LogEvent } from "./parser.js";
import { isValidTimestamp } from "./parser.js";
import { ZERO_USAGE, type ScanResult, type SessionSummary, type TokenUsage, type UsageDelta, type UsagePoint } from "./types.js";

export type TimedEvent = { event: LogEvent; file: string; line: number; order: number };

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const next = {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
  for (const [key, value] of Object.entries(next)) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${key} exceeds JavaScript's safe integer range`);
  }
  return next;
}

function difference(current: TokenUsage, previous: TokenUsage): { delta: UsageDelta; reset: boolean } {
  const keys = Object.keys(ZERO_USAGE) as (keyof TokenUsage)[];
  const delta = { ...ZERO_USAGE };
  let reset = false;
  for (const key of keys) {
    if (current[key] < previous[key]) {
      delta[key] = current[key];
      reset = true;
    } else delta[key] = current[key] - previous[key];
  }
  return { delta, reset };
}

function snapshotUsage(raw: Partial<TokenUsage>, previous: TokenUsage, warnings: string[]): TokenUsage {
  const inputTokens = raw.inputTokens ?? previous.inputTokens;
  const cachedInputTokens = raw.cachedInputTokens ?? previous.cachedInputTokens;
  const outputTokens = raw.outputTokens ?? previous.outputTokens;
  const reasoningOutputTokens = raw.reasoningOutputTokens ?? previous.reasoningOutputTokens;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  if (cachedInputTokens > inputTokens) warnings.push("cached_input_tokens exceeds input_tokens; uncached input is clamped to zero");
  if (reasoningOutputTokens > outputTokens) warnings.push("reasoning_output_tokens exceeds output_tokens; reasoning remains an output subset");
  const calculatedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(calculatedTotal)) throw new RangeError("input_tokens + output_tokens exceeds JavaScript's safe integer range");
  const totalTokens = raw.totalTokens ?? calculatedTotal;
  if (raw.totalTokens !== undefined && inputTokens + outputTokens !== raw.totalTokens) {
    warnings.push("total_tokens differs from input_tokens + output_tokens; the reported total is preserved");
  }
  return { totalTokens, inputTokens, cachedInputTokens, uncachedInputTokens, outputTokens, reasoningOutputTokens };
}

function zero(): TokenUsage { return { ...ZERO_USAGE }; }

export function cacheHitRate(usage: TokenUsage): number | null {
  return usage.inputTokens === 0 ? null : usage.cachedInputTokens / usage.inputTokens * 100;
}

function modelName(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function aggregateSession(id: string, timedEvents: TimedEvent[], isUpdating = false): SessionSummary {
  const warnings = new Set<string>();
  const usableEvents = [...timedEvents];
  const models = new Set<string>();
  let projectPath: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  for (const { event } of usableEvents) {
    if (event.kind === "meta") {
      if (!projectPath && event.cwd) projectPath = event.cwd;
      if (event.model) models.add(event.model);
      if (event.timestamp && isValidTimestamp(event.timestamp) && (!startedAt || event.timestamp < startedAt)) startedAt = event.timestamp;
    } else if (event.kind === "model" && event.model) models.add(event.model);
  }
  // Chronological ordering makes duplicate files and out-of-order log entries deterministic.
  usableEvents.sort((a, b) => {
    const ta = isValidTimestamp(a.event.timestamp) ? Date.parse(a.event.timestamp!) : Number.MAX_SAFE_INTEGER;
    const tb = isValidTimestamp(b.event.timestamp) ? Date.parse(b.event.timestamp!) : Number.MAX_SAFE_INTEGER;
    return ta - tb || a.order - b.order;
  });
  const seenSnapshots = new Set<string>();
  const snapshots = usableEvents.filter((item) => item.event.kind === "snapshot");
  // Count timestamp inversions in source order as a confidence warning.
  const byFile = new Map<string, TimedEvent[]>();
  for (const item of snapshots) byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
  for (const rows of byFile.values()) {
    let prior = -Infinity;
    for (const row of rows.sort((a, b) => a.line - b.line)) {
      const t = isValidTimestamp(row.event.timestamp) ? Date.parse(row.event.timestamp!) : undefined;
      if (t !== undefined && t < prior) warnings.add("Snapshot timestamps are out of order; timeline was sorted chronologically");
      if (t !== undefined) prior = t;
    }
  }

  const modelByFile = new Map<string, string>();
  let previous = zero();
  let cumulative = zero();
  const usage = zero();
  const timeline: UsagePoint[] = [];
  const perModel: Record<string, TokenUsage> = {};
  let eventCount = 0;
  for (const item of usableEvents) {
    const event = item.event;
    if (event.kind === "meta") {
      if (event.model) modelByFile.set(item.file, modelName(event.model)!);
      continue;
    }
    if (event.kind === "model") {
      if (event.model) modelByFile.set(item.file, modelName(event.model)!);
      continue;
    }
    const raw = event.usage;
    const dedupeKey = JSON.stringify([event.timestamp ?? null, raw]);
    if (seenSnapshots.has(dedupeKey)) continue;
    seenSnapshots.add(dedupeKey);
    eventCount++;
    const pointWarnings = [...event.warnings];
    const next = snapshotUsage(raw, previous, pointWarnings);
    pointWarnings.forEach((warning) => warnings.add(warning));
    const { delta, reset } = difference(next, previous);
    if (reset) {
      pointWarnings.push("Cumulative token counters decreased; this snapshot was treated as a reset segment");
      warnings.add("Cumulative token counters decreased; reset segments were added once to avoid losing usage");
    }
    usage.totalTokens += delta.totalTokens;
    usage.inputTokens += delta.inputTokens;
    usage.cachedInputTokens += delta.cachedInputTokens;
    usage.uncachedInputTokens += delta.uncachedInputTokens;
    usage.outputTokens += delta.outputTokens;
    usage.reasoningOutputTokens += delta.reasoningOutputTokens;
    cumulative = sumUsage(cumulative, delta);
    const model = modelName(event.model) ?? modelByFile.get(item.file) ?? (models.size === 1 ? models.values().next().value : undefined);
    const attribution = model ?? (models.size > 1 ? "Mixed / unknown" : "Unknown");
    if (!perModel[attribution]) perModel[attribution] = zero();
    perModel[attribution] = sumUsage(perModel[attribution]!, delta);
    timeline.push({ timestamp: isValidTimestamp(event.timestamp) ? event.timestamp : undefined, usage: { ...cumulative }, delta, model, kind: reset ? "reset" : "snapshot", warnings: pointWarnings });
    previous = next;
    if (event.timestamp && isValidTimestamp(event.timestamp)) {
      if (!startedAt || event.timestamp < startedAt) startedAt = event.timestamp;
      if (!updatedAt || event.timestamp > updatedAt) updatedAt = event.timestamp;
    }
  }
  if (models.size > 1 && timeline.some((point) => !point.model)) {
    warnings.add("Some usage snapshots cannot be reliably attributed across multiple models");
  }
  if (models.size > 1 && Object.keys(perModel).length <= 1) warnings.add("Mixed-model usage could not be reliably split by model");
  const confidence = warnings.size > 0 ? "uncertain" : "high";
  return {
    id, startedAt, updatedAt, projectPath, modelNames: [...models].sort(), usage,
    cacheHitRate: cacheHitRate(usage), warnings: [...warnings], confidence, isUpdating,
    timeline, perModel, eventCount,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage { return sumUsage(a, b); }

export function emptyScanResult(): ScanResult {
  return { dataVersion: 0, scannedFiles: 0, parseErrors: 0, inaccessibleDirectories: 0, inaccessibleFiles: 0, sessions: [], warnings: [], scannedAt: new Date().toISOString() };
}
