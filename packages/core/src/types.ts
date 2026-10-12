export type TokenUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type UsageDelta = TokenUsage;

export type UsagePoint = {
  timestamp?: string;
  usage: TokenUsage;
  delta: UsageDelta;
  model?: string;
  kind: "snapshot" | "reset";
  warnings: string[];
};

export type SessionSummary = {
  id: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  projectPath?: string;
  modelNames: string[];
  usage: TokenUsage;
  cacheHitRate: number | null;
  warnings: string[];
  confidence: "high" | "uncertain";
  isUpdating: boolean;
  timeline: UsagePoint[];
  perModel: Record<string, TokenUsage>;
  eventCount: number;
  /** Local-only source paths. API DTOs must omit these unless explicitly requested. */
  logPaths?: string[];
};

export type ScanResult = {
  dataVersion: number;
  scannedFiles: number;
  parseErrors: number;
  inaccessibleDirectories: number;
  inaccessibleFiles: number;
  sessions: SessionSummary[];
  warnings: string[];
  scannedAt: string;
};

export type TimeRange = "today" | "7d" | "30d" | "all" | "custom";

export const ZERO_USAGE: TokenUsage = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
