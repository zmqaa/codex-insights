import type { TokenUsage } from "./types.js";

export type LogEvent =
  | { kind: "meta"; timestamp?: string; sessionId?: string; cwd?: string; model?: string }
  | { kind: "model"; timestamp?: string; model?: string }
  | { kind: "snapshot"; timestamp?: string; usage: Partial<TokenUsage>; model?: string; warnings: string[] };

export type ParseLineResult = { event?: LogEvent; error?: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function safeCounter(value: unknown, label: string, warnings: string[]): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    warnings.push(`${label} is not a non-negative safe integer`);
    return undefined;
  }
  return value;
}

export function parseJsonlLine(line: string): ParseLineResult {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return { error: "Invalid JSON line" }; }
  const row = object(parsed);
  if (!row) return {};
  const timestamp = typeof row.timestamp === "string" ? row.timestamp : undefined;
  const type = row.type;
  const payload = object(row.payload);
  if (type === "session_meta" && payload) {
    const id = typeof payload.id === "string" ? payload.id
      : typeof payload.session_id === "string" ? payload.session_id : undefined;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const model = typeof payload.model === "string" ? payload.model : undefined;
    return { event: { kind: "meta", timestamp, sessionId: id, cwd, model } };
  }
  if (type === "turn_context" && payload) {
    const model = typeof payload.model === "string" ? payload.model : undefined;
    return { event: { kind: "model", timestamp, model } };
  }
  if (type !== "event_msg" || !payload || payload.type !== "token_count") return {};
  const info = object(payload.info);
  const total = object(info?.total_token_usage);
  if (!total) return {};
  const warnings: string[] = [];
  const usage: Partial<TokenUsage> = {
    totalTokens: safeCounter(total.total_tokens, "total_tokens", warnings),
    inputTokens: safeCounter(total.input_tokens, "input_tokens", warnings),
    cachedInputTokens: safeCounter(total.cached_input_tokens, "cached_input_tokens", warnings),
    outputTokens: safeCounter(total.output_tokens, "output_tokens", warnings),
    reasoningOutputTokens: safeCounter(total.reasoning_output_tokens, "reasoning_output_tokens", warnings),
  };
  // last_token_usage is intentionally ignored: it is a recent/incremental figure,
  // not part of the cumulative total_token_usage snapshot.
  return { event: { kind: "snapshot", timestamp, usage, warnings } };
}

export function isValidTimestamp(value?: string): boolean {
  return !!value && Number.isFinite(Date.parse(value));
}
