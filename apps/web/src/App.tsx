import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { TokenUsage } from "@codex-insight/core";
import { browserApi, chooseBrowserDirectory, chooseBrowserFiles, supportsDirectoryPicker } from "./browserData.js";

const hostedMode = import.meta.env.MODE === "hosted";

type Range = "today" | "7d" | "30d" | "all" | "custom";
type ProjectRow = TokenUsage & { id: string; name: string; sessionCount: number };
type ApiPricePerMillionUsd = { input: number; cachedInput: number; output: number };
type ModelRow = TokenUsage & {
  name: string; sessionCount: number; cacheHitRate: number | null; uncachedInputRate: number | null;
  estimatedApiCostUsd: number | null; apiPricePerMillionUsd?: ApiPricePerMillionUsd;
};
type DailyRow = TokenUsage & { date: string };
type ApiCostSummary = {
  estimatedUsd: number; pricedModelCount: number; totalModelCount: number;
  status: "complete" | "partial" | "unavailable"; unpricedModels: string[];
  assumedPriceModels: string[]; sourceUrl: string; checkedOn: string; basis: string;
};
type Summary = {
  range: Range; since?: string; until?: string; usage: TokenUsage; cacheHitRate: number | null; apiCost: ApiCostSummary; daily: DailyRow[];
  projects: ProjectRow[]; models: ModelRow[]; sessionCount: number; scannedFiles: number;
  parseErrors: number; scannedAt: string; warnings: string[];
};
type AnalysisSessionOption = { id: string; title?: string; projectKey: string; projectName: string; updatedAt?: string };
type AnalysisData = Pick<Summary, "usage" | "cacheHitRate" | "apiCost" | "daily" | "projects" | "models" | "warnings"> & {
  sessions: AnalysisSessionOption[]; selectedSessionId: string | null; sessionCount: number; scannedAt: string;
};
type Session = {
  id: string; title?: string; startedAt?: string; updatedAt?: string; projectKey: string; projectName: string;
  modelNames: string[]; modelLabel: string; usage: TokenUsage; cacheHitRate: number | null;
  warnings: string[]; confidence: "high" | "uncertain"; isUpdating: boolean; eventCount: number;
};
type SessionPage = { items: Session[]; total: number; page: number; limit: number };
type SessionDetailData = Session & { perModel: Record<string, TokenUsage>; projectPath?: string; logPaths?: string[] };
type UsagePoint = {
  timestamp?: string; usage: TokenUsage; delta: TokenUsage; model?: string;
  kind: "snapshot" | "reset"; warnings: string[];
};
type Health = {
  dataVersion: string;
  status: string; scannedAt: string; sessionCount: number; scannedFiles: number;
  parseErrors: number; inaccessibleDirectories: number; inaccessibleFiles: number; sourceAvailable: boolean; refreshMs: number;
};
type Settings = { refreshMs: number; sourceMode: "automatic" | "custom" | "browser" | "snapshot"; sourceDirectory?: string };
type Tab = "overview" | "sessions" | "analysis" | "settings";
type Theme = "dark" | "light";
type TimeMode = "local" | "utc";

const metrics: Array<{ key: keyof TokenUsage; label: string; hint: string; color: string }> = [
  { key: "totalTokens", label: "累计 Token", hint: "日志报告的累计总量。若日志数据不一致，总量可能与输入 + 输出不同。", color: "violet" },
  { key: "inputTokens", label: "输入 Token", hint: "其中包含缓存输入 Token。", color: "blue" },
  { key: "cachedInputTokens", label: "缓存输入", hint: "属于输入 Token 的子集，不会再次加到累计 Token 中。", color: "cyan" },
  { key: "uncachedInputTokens", label: "未缓存输入", hint: "输入减去缓存输入；若源数据不一致，结果最低按 0 计算。", color: "teal" },
  { key: "outputTokens", label: "输出 Token", hint: "其中包含推理 Token。", color: "orange" },
  { key: "reasoningOutputTokens", label: "推理 Token", hint: "属于输出 Token 的子集，不会在输出量之外重复累加。", color: "pink" },
];
const timelineOptions: Array<{ key: keyof TokenUsage; label: string }> = metrics.map(({ key, label }) => ({ key, label }));
const timelineColors: Record<keyof TokenUsage, string> = {
  totalTokens: "#a89aff", inputTokens: "#7bafff", cachedInputTokens: "#59bbdb",
  uncachedInputTokens: "#63cbb5", outputTokens: "#f2aa70", reasoningOutputTokens: "#e885bd",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  if (hostedMode) return browserApi<T>(url, init);
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(localizeMessage(body.error ?? `请求失败（${response.status}）`));
  return body as T;
}

function localizeMessage(message: string): string {
  const exact: Record<string, string> = {
    "Failed to fetch": "无法连接本地服务，请确认服务正在运行。",
    "NetworkError when attempting to fetch resource.": "无法连接本地服务，请确认服务正在运行。",
    "Local loopback access is required": "仅允许通过本机回环地址访问。",
    "Session not found": "没有找到此会话。",
    "Project not found": "没有找到此项目。",
    "Selected session does not belong to the selected project": "所选会话不属于当前项目。",
    "Refresh interval must be 2, 3, 5, or 10 seconds": "刷新间隔必须为 2、3、5 或 10 秒。",
    "Session directory must be an absolute path": "会话目录必须使用绝对路径。",
    "Session directory does not exist or cannot be read": "会话目录不存在或无法读取。",
    "Session path must point to a directory": "会话路径必须指向一个文件夹。",
    "No available loopback port": "没有可用的本机端口。",
    "Unexpected server error": "服务器发生意外错误。",
  };
  if (exact[message]) return exact[message]!;
  if (message.startsWith("cached_input_tokens exceeds input_tokens")) return "缓存输入 Token 超过输入 Token；未缓存输入已按 0 计算。";
  if (message.startsWith("reasoning_output_tokens exceeds output_tokens")) return "推理 Token 超过输出 Token；仍按输出 Token 的子集处理。";
  if (message.startsWith("total_tokens differs from input_tokens + output_tokens")) return "日志报告的累计 Token 与输入 + 输出之和不一致；已保留日志报告的累计值。";
  if (message.startsWith("Snapshot timestamps are out of order")) return "快照时间戳顺序异常；时间线已按时间排序。";
  if (message.startsWith("Cumulative token counters decreased; this snapshot")) return "累计 Token 计数减少；此快照已按计数器重置处理。";
  if (message.startsWith("Cumulative token counters decreased; reset segments")) return "累计 Token 计数减少；已将重置区段计入一次，以免遗漏用量。";
  if (message.startsWith("Some usage snapshots cannot be reliably attributed")) return "部分用量快照无法可靠地归属到不同模型。";
  if (message.startsWith("Mixed-model usage could not be reliably split")) return "无法可靠地按模型拆分混合模型用量。";
  if (message.startsWith("Log file was truncated or replaced")) return "日志文件已被截断或替换；该文件之前的快照已丢弃。";
  if (message.startsWith("Session metadata ID is missing")) return "会话元数据缺少 ID；已使用日志文件名识别此会话。";
  const malformed = message.match(/^(\d+) malformed JSONL line\(s\) skipped$/);
  if (malformed) return `已跳过 ${malformed[1]} 行格式错误的 JSONL 数据。`;
  const unreadable = message.match(/^(\d+) matching session log file\(s\) could not be read$/);
  if (unreadable) return `${unreadable[1]} 个匹配的会话日志文件无法读取。`;
  const invalidCounter = message.match(/^([\w.]+) is not a non-negative safe integer$/);
  if (invalidCounter) return `字段 ${invalidCounter[1]} 不是有效的非负整数。`;
  const directoryError = message.match(/^(Cannot read a session directory|Session directory is unavailable) \((.*)\)$/);
  if (directoryError) return `${directoryError[1] === "Cannot read a session directory" ? "无法读取会话目录" : "会话目录不可用"}（${directoryError[2]}）`;
  return message;
}

function formatTokens(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
function formatShort(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(value >= 1_000_000_000 ? 0 : 1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)}万`;
  return formatTokens(value);
}
function formatRate(value: number | null): string { return value === null ? "不适用" : `${value.toFixed(2)}%`; }
function formatShare(value: number | null): string { return value === null ? "—" : `${value.toFixed(1)}%`; }
function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.000001) return "<$0.000001";
  const minimumFractionDigits = value < 0.01 ? 4 : 2;
  const maximumFractionDigits = value < 1 ? 6 : 2;
  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits, maximumFractionDigits }).format(value)}`;
}
function formatTime(value: string | undefined, mode: TimeMode): string {
  if (!value) return "未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    ...(mode === "utc" ? { timeZone: "UTC", timeZoneName: "short" as const } : {}),
  }).format(date);
}
function rangeQuery(range: Range, since: string, until: string): string {
  const params = new URLSearchParams({ range });
  if (range === "custom") {
    if (since) params.set("since", new Date(`${since}T00:00:00`).toISOString());
    if (until) params.set("until", new Date(`${until}T23:59:59.999`).toISOString());
  }
  return params.toString();
}
function rangeRefreshKey(range: Range, now = Date.now()): string {
  if (range === "today") return new Date(now).toISOString().slice(0, 10);
  if (range === "7d" || range === "30d") return String(Math.floor(now / 60_000));
  return "";
}
function localDay(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : date;
}

function StatCard({ label, value, hint, color, footnote }: { label: string; value: string; hint: string; color: string; footnote?: string }) {
  return <article className={`stat-card accent-${color}`} title={hint}>
    <div className="stat-label"><span className="stat-dot" />{label}<span className="hint-mark" aria-label={hint}>i</span></div>
    <strong>{value}</strong>
    {footnote && <span className="stat-footnote">{footnote}</span>}
  </article>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return <div className="empty-state"><span className="empty-glyph">⌁</span><strong>{title}</strong><p>{message}</p></div>;
}

function DataWarningInfo({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return <div className="data-warning-help">
    <button className="data-warning-trigger" type="button" aria-label={`数据提示，共 ${warnings.length} 条`} aria-describedby="data-warning-tooltip" title="悬停或聚焦查看数据提示">i</button>
    <div className="data-warning-tooltip" id="data-warning-tooltip" role="tooltip">
      <strong>数据提示 · {warnings.length} 条</strong>
      <ul>{warnings.slice(0, 6).map((warning) => <li key={warning}>{localizeMessage(warning)}</li>)}</ul>
      {warnings.length > 6 && <small>另有 {warnings.length - 6} 条提示未显示。</small>}
    </div>
  </div>;
}

function RangeControl({ value, onChange, since, until, setSince, setUntil }: {
  value: Range; onChange: (range: Range) => void; since: string; until: string;
  setSince: (value: string) => void; setUntil: (value: string) => void;
}) {
  const ranges: Array<[Range, string]> = [["today", "今天"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["all", "全部时间"], ["custom", "自定义"]];
  return <div className="range-control-wrap">
    <div className="segmented-control" aria-label="日期范围">
      {ranges.map(([key, label]) => <button key={key} className={value === key ? "selected" : ""} onClick={() => onChange(key)}>{label}</button>)}
    </div>
    {value === "custom" && <div className="date-fields">
      <label><span>开始日期</span><input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></label>
      <label><span>结束日期</span><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
    </div>}
  </div>;
}

function SessionTable({ items, onSelect, timeMode, compact = false }: { items: Session[]; onSelect: (id: string) => void; timeMode: TimeMode; compact?: boolean }) {
  if (!items.length) return <EmptyState title="没有找到会话" message="试试扩大日期范围或清除筛选条件。" />;
  return <div className="table-scroll"><table className="session-table">
    <thead><tr><th>会话</th><th>项目</th><th>模型</th><th>最近活动</th><th>创建时间</th><th>累计 Token</th><th>输出</th><th>缓存命中率</th><th>状态</th></tr></thead>
    <tbody>{items.slice(0, compact ? 6 : undefined).map((session) => <tr key={session.id} onClick={() => onSelect(session.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onSelect(session.id); }}>
      <td><span className={session.title ? "session-title" : "session-id"} title={session.id}>{session.title || session.id}</span>{session.title && <small className="session-id-caption" title={session.id}>{session.id}</small>}</td>
      <td><span className="project-cell"><i className="folder-icon">▱</i>{session.projectName}</span></td>
      <td><span className="model-pill">{session.modelLabel}</span></td>
      <td>{formatTime(session.updatedAt, timeMode)}</td>
      <td className="creation-time">{formatTime(session.startedAt, timeMode)}</td>
      <td className="numeric strong-number">{formatTokens(session.usage.totalTokens)}</td>
      <td className="numeric">{formatTokens(session.usage.outputTokens)}</td>
      <td><span className={session.cacheHitRate === null ? "rate-na" : "rate-pill"}>{formatRate(session.cacheHitRate)}</span></td>
      <td><span className={`state-pill ${session.isUpdating ? "active" : ""}`}><i />{session.isUpdating ? "更新中" : "已保存"}</span></td>
    </tr>)}</tbody>
  </table></div>;
}

function Breakdown({ title, subtitle, headers, rows, onSelect }: {
  title: string; subtitle: string; headers: string[];
  rows: Array<{
    id: string; name: string; usage: TokenUsage; sessions: number;
    cacheHitRate?: number | null; uncachedInputRate?: number | null; estimatedApiCostUsd?: number | null;
    apiPricePerMillionUsd?: ApiPricePerMillionUsd;
  }>;
  onSelect?: (id: string) => void;
}) {
  return <section className="panel breakdown-panel">
    <div className="panel-heading"><div><h3>{title}</h3><p>{subtitle}</p></div><span className="subtle-count">{rows.length} 项</span></div>
    {rows.length === 0 ? <EmptyState title="暂无汇总数据" message="检测到 Token 快照后，统计信息会显示在这里。" /> : <div className="breakdown-list">
      {rows.slice(0, 7).map((row, index) => <button key={row.id} className={`breakdown-row ${onSelect ? "clickable" : ""}`} onClick={() => onSelect?.(row.id)} disabled={!onSelect}>
        <span className="rank">{String(index + 1).padStart(2, "0")}</span><span className="breakdown-name" title={row.name}>{row.name}<small>{row.sessions} 个会话{row.cacheHitRate !== undefined && <> · 缓存 {formatShare(row.cacheHitRate)} · 未缓存 {formatShare(row.uncachedInputRate ?? null)}</>}</small></span>
        <span className="breakdown-bar"><i style={{ width: `${Math.max(4, row.usage.totalTokens / Math.max(1, rows[0]!.usage.totalTokens) * 100)}%` }} /></span>
        <span className="breakdown-value">{formatShort(row.usage.totalTokens)}<small>Token</small>
          {row.estimatedApiCostUsd !== undefined && <small className={`breakdown-price ${row.estimatedApiCostUsd === null ? "unpriced" : ""}`} title={row.apiPricePerMillionUsd
            ? `标准短上下文 API 单价 / 1M Token：未缓存输入 $${row.apiPricePerMillionUsd.input}，缓存输入 $${row.apiPricePerMillionUsd.cachedInput}，输出 $${row.apiPricePerMillionUsd.output}`
            : "没有匹配到公开 API 单价，此模型未计入费用小计。"}>
            {row.estimatedApiCostUsd === null ? "无 API 价" : `≈ ${formatUsd(row.estimatedApiCostUsd)}`}
          </small>}
        </span>
      </button>)}
    </div>}
    {headers.length > 0 && <div className="breakdown-legend"><span>{headers[0]}</span><span>{headers[1]}</span></div>}
  </section>;
}

function SessionDetail({ sessionId, timeMode, privacyMode, pollToken, onClose }: {
  sessionId: string; timeMode: TimeMode; privacyMode: boolean; pollToken: string; onClose: () => void;
}) {
  const [detail, setDetail] = useState<SessionDetailData>();
  const [points, setPoints] = useState<UsagePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState<Array<keyof TokenUsage>>(["cachedInputTokens", "uncachedInputTokens", "outputTokens"]);
  const [eventPage, setEventPage] = useState(1);
  const [showPath, setShowPath] = useState(!privacyMode);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (revealPath = showPath) => {
    try {
      const detailUrl = `/api/sessions/${encodeURIComponent(sessionId)}${revealPath ? "?revealPath=1" : ""}`;
      const [nextDetail, timeline] = await Promise.all([
        api<SessionDetailData>(detailUrl), api<{ points: UsagePoint[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/timeline`),
      ]);
      setDetail(nextDetail); setPoints(timeline.points); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "无法加载会话"); }
    finally { setLoading(false); }
  }, [sessionId, showPath]);

  useEffect(() => { setLoading(true); void load(); }, [load, pollToken]);
  useEffect(() => { if (!privacyMode && !showPath) setShowPath(true); }, [privacyMode, showPath]);
  useEffect(() => { setEventPage(1); }, [sessionId]);

  const lineData = useMemo(() => points.filter((point) => point.timestamp).map((point) => ({
    time: formatTime(point.timestamp, timeMode), ...point.usage, kind: point.kind,
  })), [points, timeMode]);
  const orderedEvents = useMemo(() => [...points].reverse(), [points]);
  const eventPageCount = Math.max(1, Math.ceil(orderedEvents.length / 10));
  const pageEvents = orderedEvents.slice((eventPage - 1) * 10, eventPage * 10);
  useEffect(() => { if (eventPage > eventPageCount) setEventPage(eventPageCount); }, [eventPage, eventPageCount]);
  const toggleDimension = (dimension: keyof TokenUsage) => setDimensions((current) => current.includes(dimension)
    ? current.filter((item) => item !== dimension)
    : [...current, dimension]);
  if (loading && !detail) return <div className="detail-loading"><span className="spinner" /> 正在读取会话统计…</div>;
  if (error && !detail) return <div className="panel error-card"><strong>无法加载此会话</strong><p>{localizeMessage(error)}</p><button className="button secondary" onClick={onClose}>返回会话列表</button></div>;
  if (!detail) return null;

  const summaryText = [
    `会话：${detail.title || detail.id}`,
    `会话 ID：${detail.id}`,
    `项目：${detail.projectName}`,
    `模型：${detail.modelLabel}`,
    `累计 Token：${formatTokens(detail.usage.totalTokens)}`,
    `输入 Token：${formatTokens(detail.usage.inputTokens)}（缓存 ${formatTokens(detail.usage.cachedInputTokens)}，未缓存 ${formatTokens(detail.usage.uncachedInputTokens)}）`,
    `输出 Token：${formatTokens(detail.usage.outputTokens)}（其中推理 Token ${formatTokens(detail.usage.reasoningOutputTokens)}）`,
    `缓存命中率：${formatRate(detail.cacheHitRate)}`,
  ].join("\n");
  const copySummary = async () => {
    try { await navigator.clipboard.writeText(summaryText); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setError("此浏览器无法访问剪贴板。"); }
  };
  const exportJson = () => {
    const payload = { id: detail.id, title: detail.title, project: detail.projectName, models: detail.modelNames, startedAt: detail.startedAt, updatedAt: detail.updatedAt, usage: detail.usage, cacheHitRate: detail.cacheHitRate, confidence: detail.confidence, warnings: detail.warnings, timeline: points };
    download(`codex-session-${detail.id}.json`, JSON.stringify(payload, null, 2), "application/json");
  };
  const exportCsv = () => {
    const header = "timestamp,kind,model,total_tokens,input_tokens,cached_input_tokens,uncached_input_tokens,output_tokens,reasoning_output_tokens";
    const rows = points.map((point) => [point.timestamp ?? "", point.kind, point.model ?? "未知", ...Object.values(point.usage)].map(csvCell).join(","));
    download(`codex-session-${detail.id}.csv`, [header, ...rows].join("\r\n"), "text/csv;charset=utf-8");
  };
  const inputTotal = detail.usage.cachedInputTokens + detail.usage.uncachedInputTokens;
  const compositionTotal = inputTotal + detail.usage.outputTokens;

  return <div className="detail-view">
    <div className="detail-toolbar"><button className="back-button" onClick={onClose}><span>←</span> 所有会话</button><div className="detail-actions">
      <button className="button secondary" onClick={() => void copySummary()}>{copied ? "✓ 已复制" : "▣ 复制摘要"}</button>
      <button className="button secondary" onClick={exportCsv}>↓ CSV</button><button className="button secondary" onClick={exportJson}>↓ JSON</button>
    </div></div>
    <section className="detail-hero panel">
      <div className="detail-title-wrap"><div className="eyebrow">会话详情 <span className={detail.isUpdating ? "live-dot" : ""}>{detail.isUpdating ? "实时更新" : "已归档"}</span></div>
        <h1 title={detail.id}>{detail.title || detail.id}</h1><div className="detail-subtitle">{detail.title && <span>会话 ID {detail.id}</span>}<span>▱ {detail.projectName}</span><span>◈ {detail.modelLabel}</span><span>创建时间 {formatTime(detail.startedAt, timeMode)}</span><span>最近活动 {formatTime(detail.updatedAt, timeMode)}</span></div>
      </div>
      <div className="confidence-box"><span>数据可信度</span><strong className={detail.confidence === "high" ? "confidence-high" : "confidence-low"}>{detail.confidence === "high" ? "高" : "请检查警告"}</strong></div>
    </section>
      {detail.warnings.length > 0 && <div className="warning-banner"><strong>部分日志统计需要检查</strong><ul>{detail.warnings.map((warning) => <li key={warning}>{localizeMessage(warning)}</li>)}</ul></div>}
    <div className="metric-grid detail-metrics">
      {metrics.map((metric) => <StatCard key={metric.key} label={metric.label} value={formatTokens(detail.usage[metric.key])} hint={metric.hint} color={metric.color} />)}
      <StatCard label="缓存命中率" value={formatRate(detail.cacheHitRate)} hint="缓存输入 Token ÷ 输入 Token；输入为 0 时不适用。" color="green" />
    </div>
    <div className="detail-grid">
      <section className="panel detail-chart-panel">
        <div className="panel-heading"><div><h3>Token 使用趋势</h3><p>每个点表示该事件发生后的累计快照，可同时对比多种 Token 类型。</p></div></div>
        <div className="trend-series-controls" aria-label="趋势图 Token 类型">
          {timelineOptions.map((item) => <button key={item.key} type="button" className={`trend-series-toggle ${dimensions.includes(item.key) ? "selected" : ""}`} aria-pressed={dimensions.includes(item.key)} onClick={() => toggleDimension(item.key)}>
            <i style={{ backgroundColor: timelineColors[item.key] }} />{item.label}
          </button>)}
        </div>
        {lineData.length === 0 ? <EmptyState title="没有带时间戳的快照" message="日志中没有可用于趋势图的时间点。" /> : dimensions.length === 0 ? <EmptyState title="请选择趋势指标" message="点击上方的 Token 类型即可添加曲线。" /> : <div className="chart-frame detail-line-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={lineData} margin={{ top: 12, right: 16, bottom: 6, left: 8 }}>
          <CartesianGrid strokeDasharray="3 6" vertical={false} stroke="var(--grid)" /><XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} minTickGap={32} /><YAxis tickFormatter={formatShort} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={54} /><Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [formatTokens(Number(value)), timelineOptions.find((item) => item.key === name)?.label ?? String(name)]} />
          {dimensions.map((dimension) => <Line key={dimension} type="monotone" dataKey={dimension} name={timelineOptions.find((item) => item.key === dimension)?.label} stroke={timelineColors[dimension]} strokeWidth={2.5} dot={{ r: 2.5, fill: timelineColors[dimension], strokeWidth: 0 }} activeDot={{ r: 4 }} />)}
        </LineChart></ResponsiveContainer></div>}
      </section>
      <section className="panel composition-panel">
        <div className="panel-heading"><div><h3>Token 构成</h3><p>输入 Token 按缓存与未缓存部分拆分显示。</p></div></div>
        <div className="composition-total"><strong>{formatShort(compositionTotal)}</strong><span>输入 + 输出</span></div>
        <div className="composition-track" aria-label="缓存输入、未缓存输入和输出的构成">
          {compositionTotal > 0 && <>
            <i className="cached-segment" style={{ width: `${detail.usage.cachedInputTokens / compositionTotal * 100}%` }} />
            <i className="uncached-segment" style={{ width: `${detail.usage.uncachedInputTokens / compositionTotal * 100}%` }} />
            <i className="output-segment" style={{ width: `${detail.usage.outputTokens / compositionTotal * 100}%` }} />
          </>}
        </div>
        <div className="composition-legend">
          <div><i className="legend-cached" /><span>缓存输入</span><strong>{formatTokens(detail.usage.cachedInputTokens)}</strong></div>
          <div><i className="legend-uncached" /><span>未缓存输入</span><strong>{formatTokens(detail.usage.uncachedInputTokens)}</strong></div>
          <div><i className="legend-output" /><span>输出</span><strong>{formatTokens(detail.usage.outputTokens)}</strong></div>
          <div className="subset-note">推理 Token（{formatTokens(detail.usage.reasoningOutputTokens)}）已包含在输出中。</div>
        </div>
        {Object.keys(detail.perModel).length > 1 && <div className="model-allocation"><strong>按模型归属的 Token 使用量</strong>{Object.entries(detail.perModel).map(([model, usage]) => <div key={model}><span>{model}</span><b>{formatTokens(usage.totalTokens)}</b></div>)}</div>}
        <div className="detail-path">
          <div><strong>来源文件</strong><small>为保护隐私，默认隐藏完整本地路径。</small></div>
          {showPath ? <button className="path-text" onClick={() => setShowPath(false)} title="隐藏完整路径">{detail.logPaths?.join(" · ") || "没有可用的来源文件路径"}</button> : <button className="button subtle-button" onClick={() => { setShowPath(true); void load(true); }}>显示路径</button>}
        </div>
      </section>
    </div>
    <section className="panel events-panel">
      <div className="panel-heading"><div><h3>明细</h3><p>仅显示 Token 快照增量和计数器重置，不会展示对话内容。</p></div><span className="subtle-count">{points.length} 条记录</span></div>
      {points.length === 0 ? <EmptyState title="没有 Token 快照" message="此会话中没有识别到累计 Token 事件。" /> : <div className="event-list">
        {pageEvents.map((point, index) => <article className="event-row" key={`${point.timestamp}-${(eventPage - 1) * 10 + index}`}>
          <span className={`event-mark ${point.kind === "reset" ? "reset" : ""}`}>{point.kind === "reset" ? "↺" : "↗"}</span>
          <div className="event-main"><strong>{point.kind === "reset" ? "计数器重置" : "用量快照"}</strong><span>{formatTime(point.timestamp, timeMode)}{point.model ? ` · ${point.model}` : " · 模型未知"}</span>
            {point.warnings.length > 0 && <small className="event-warning">{point.warnings.map(localizeMessage).join("；")}</small>}</div>
          <div className="event-delta"><strong>+{formatTokens(point.delta.totalTokens)}</strong><span>输入 {formatShort(point.delta.inputTokens)} · 输出 {formatShort(point.delta.outputTokens)}</span></div>
        </article>)}
      </div>}
      {points.length > 10 && <div className="detail-pagination">
        <span>显示 {(eventPage - 1) * 10 + 1}–{Math.min(eventPage * 10, points.length)} 条，共 {points.length} 条</span>
        <div className="table-pagination"><button className="button secondary" onClick={() => setEventPage((page) => Math.max(1, page - 1))} disabled={eventPage <= 1}>上一页</button><span>第 {eventPage} / {eventPageCount} 页</span><button className="button secondary" onClick={() => setEventPage((page) => Math.min(eventPageCount, page + 1))} disabled={eventPage >= eventPageCount}>下一页</button></div>
      </div>}
    </section>
    {error && <div className="inline-error">{error}</div>}
  </div>;
}

function UsageAnalysis({ timeMode, pollToken }: { timeMode: TimeMode; pollToken: string }) {
  const [range, setRange] = useState<Range>("all");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [data, setData] = useState<AnalysisData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [windowTick, setWindowTick] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams(rangeQuery(range, since, until));
    if (projectId) params.set("projectId", projectId);
    if (sessionId) params.set("sessionId", sessionId);
    return params.toString();
  }, [range, since, until, projectId, sessionId]);
  const timeKey = useMemo(() => rangeRefreshKey(range), [range, windowTick]);

  useEffect(() => {
    if (range === "all" || range === "custom") return;
    const timer = window.setInterval(() => setWindowTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [range]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api<AnalysisData>(`/api/analysis?${query}`)
      .then((next) => { if (alive) { setData(next); setError(""); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "无法加载用量分析"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query, pollToken, timeKey]);

  const setAnalysisRange = (value: Range) => {
    setRange(value);
    if (value === "custom" && !since) setSince(new Date().toISOString().slice(0, 10));
    if (value === "custom" && !until) setUntil(new Date().toISOString().slice(0, 10));
  };
  const costParts = useMemo(() => {
    const result = { cachedInput: 0, uncachedInput: 0, output: 0 };
    for (const model of data?.models ?? []) {
      const price = model.apiPricePerMillionUsd;
      if (!price || model.estimatedApiCostUsd === null) continue;
      const cached = Math.min(model.cachedInputTokens, model.inputTokens);
      const uncached = Math.max(0, model.inputTokens - cached);
      result.cachedInput += cached * price.cachedInput / 1_000_000;
      result.uncachedInput += uncached * price.input / 1_000_000;
      result.output += model.outputTokens * price.output / 1_000_000;
    }
    return result;
  }, [data?.models]);
  const costRows = useMemo(() => (data?.models ?? [])
    .filter((model) => model.estimatedApiCostUsd !== null)
    .sort((a, b) => (b.estimatedApiCostUsd ?? 0) - (a.estimatedApiCostUsd ?? 0)), [data?.models]);
  const projectOptions = useMemo(() => {
    const byKey = new Map<string, { id: string; name: string; sessionCount: number }>();
    for (const session of data?.sessions ?? []) {
      const existing = byKey.get(session.projectKey);
      if (existing) existing.sessionCount += 1;
      else byKey.set(session.projectKey, { id: session.projectKey, name: session.projectName, sessionCount: 1 });
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [data?.sessions]);
  const sessionOptions = useMemo(() => (data?.sessions ?? [])
    .filter((session) => !projectId || session.projectKey === projectId), [data?.sessions, projectId]);

  return <div className="analysis-view">
    <section className="page-heading analysis-heading">
      <div><div className="eyebrow">TOKEN · 时间 · API 价等值</div><div className="analysis-title-row"><h1>用量分析</h1><DataWarningInfo warnings={data?.warnings ?? []} /></div><p>按时间、Token 类型和模型查看本地用量；可从全部会话切换到单个会话。</p></div>
      <div className="heading-meta"><span><i className="live-dot" />{data?.sessionCount ?? 0} 个会话参与统计</span><small>上次扫描：{formatTime(data?.scannedAt, timeMode)}</small></div>
    </section>
    <section className="toolbar-row analysis-toolbar">
      <RangeControl value={range} onChange={setAnalysisRange} since={since} until={until} setSince={setSince} setUntil={setUntil} />
      <div className="analysis-filter-group">
        <label className="analysis-filter-select"><span>项目范围</span><select className="select-control" value={projectId} onChange={(event) => { setProjectId(event.target.value); setSessionId(""); }}>
          <option value="">全部项目</option>
          {projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.sessionCount} 个会话</option>)}
        </select></label>
        <label className="analysis-filter-select"><span>会话范围</span><select className="select-control" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
        <option value="">全部会话</option>
        {sessionOptions.map((session) => <option key={session.id} value={session.id} title={session.id}>{session.title || session.id} · {session.projectName} · {formatTime(session.updatedAt, timeMode)}</option>)}
        </select></label>
      </div>
    </section>
    {error && <div className="panel error-card"><strong>无法加载用量分析</strong><p>{localizeMessage(error)}</p></div>}
    {loading && !data ? <div className="loading-panel"><span className="spinner" /> 正在汇总用量数据…</div> : data && <>
      <div className="metric-grid analysis-metrics">
        {metrics.map((metric) => <StatCard key={metric.key} label={metric.label} value={formatTokens(data.usage[metric.key])} hint={metric.hint} color={metric.color} />)}
        <StatCard label="缓存命中率" value={formatRate(data.cacheHitRate)} hint="缓存输入 Token ÷ 输入 Token；输入为 0 时不适用。" color="green" />
        <StatCard label="API 价等值" value={data.apiCost.pricedModelCount === 0 ? "无匹配价格" : `≈ ${formatUsd(data.apiCost.estimatedUsd)}`} hint={`按官网公开 API 单价估算${data.apiCost.assumedPriceModels.length ? "；其中 gpt-5.6-luna 按两倍 gpt-6-luna 推算" : ""}，不代表 Codex 订阅费用或实际账单。`} color="blue" footnote={`${data.apiCost.pricedModelCount}/${data.apiCost.totalModelCount} 个模型匹配 · USD`} />
      </div>
      <div className="analysis-grid">
        <section className="panel usage-panel">
          <div className="panel-heading"><div><h3>按日 Token 用量</h3><p>缓存输入、未缓存输入和输出按 UTC 日期堆叠；推理 Token 已包含在输出中。</p></div><span className="chart-total">{formatShort(data.usage.totalTokens)}<small>所选范围内的 Token</small></span></div>
          {data.daily.length === 0 ? <EmptyState title="此范围内没有用量" message="选择其他时间范围，或继续使用 Codex 以查看每日统计。" /> : <div className="chart-frame analysis-daily-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.daily} margin={{ top: 14, right: 8, bottom: 4, left: 8 }} barCategoryGap="30%">
            <CartesianGrid strokeDasharray="3 6" vertical={false} stroke="var(--grid)" /><XAxis dataKey="date" tickFormatter={localDay} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} minTickGap={28} /><YAxis tickFormatter={formatShort} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} width={54} /><Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => localDay(String(value))} formatter={(value, name) => [formatTokens(Number(value)), name]} /><Bar dataKey="cachedInputTokens" stackId="analysis" name="缓存输入" fill="#56b6d9" /><Bar dataKey="uncachedInputTokens" stackId="analysis" name="未缓存输入" fill="#8277ee" /><Bar dataKey="outputTokens" stackId="analysis" name="输出" fill="#f3a66b" radius={[4, 4, 0, 0]} />
          </BarChart></ResponsiveContainer></div>}
          <div className="chart-legend"><span><i className="legend-cached" />缓存输入</span><span><i className="legend-uncached" />未缓存输入</span><span><i className="legend-output" />输出 <small>含推理 Token</small></span></div>
        </section>
        <section className="panel analysis-cost-panel">
          <div className="panel-heading"><div><h3>按 Token 类型估算费用</h3><p>仅统计已匹配公开单价的模型。</p></div></div>
          <div className="analysis-cost-list">
            <div><span><i className="cost-swatch uncached" />未缓存输入</span><strong>{formatUsd(costParts.uncachedInput)}</strong></div>
            <div><span><i className="cost-swatch cached" />缓存输入</span><strong>{formatUsd(costParts.cachedInput)}</strong></div>
            <div><span><i className="cost-swatch output" />输出</span><strong>{formatUsd(costParts.output)}</strong></div>
            <div className="analysis-cost-total"><span>估算合计</span><strong>{data.apiCost.pricedModelCount === 0 ? "无匹配价格" : formatUsd(data.apiCost.estimatedUsd)}</strong></div>
          </div>
          <p className="analysis-cost-note">以上为标准短上下文 API 单价计算的美元等值，不是 Codex 订阅价格或实际 API 账单。</p>
        </section>
      </div>
      <section className="panel analysis-model-panel">
        <div className="panel-heading"><div><h3>模型费用对比</h3><p>按各模型实际记录的 Token 用量和对应 API 单价估算，可横向比较模型成本。</p></div><span className="subtle-count">{costRows.length} 个已计价模型</span></div>
        {costRows.length === 0 ? <EmptyState title="暂无可比较的费用" message="当前范围内没有匹配到公开 API 单价的模型。" /> : <div className="analysis-model-chart" style={{ height: Math.max(170, costRows.length * 44) }}><ResponsiveContainer width="100%" height="100%"><BarChart data={costRows} layout="vertical" margin={{ top: 8, right: 32, bottom: 8, left: 8 }} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 6" horizontal={false} stroke="var(--grid)" /><XAxis type="number" tickFormatter={(value) => `$${Number(value).toPrecision(2)}`} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} /><YAxis type="category" dataKey="name" width={135} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} /><Tooltip contentStyle={tooltipStyle} formatter={(value) => [formatUsd(Number(value)), "估算费用"]} /><Bar dataKey="estimatedApiCostUsd" name="估算费用" fill="var(--accent)" radius={[0, 5, 5, 0]} />
        </BarChart></ResponsiveContainer></div>}
        {data.apiCost.unpricedModels.length > 0 && <div className="unpriced-models">未计入估算：{data.apiCost.unpricedModels.join("、")}（暂无匹配价格）</div>}
        <div className="analysis-source-note">单价来源：<a href={data.apiCost.sourceUrl} target="_blank" rel="noreferrer">OpenAI API 价格 ↗</a> · 核对日期 {data.apiCost.checkedOn} · {data.apiCost.basis}{data.apiCost.assumedPriceModels.length > 0 && <><br />注：官网未列出 gpt-5.6-luna；此模型采用两倍 gpt-6-luna 的推算单价。</>}</div>
      </section>
      <section className="panel analysis-project-panel">
        <div className="panel-heading"><div><h3>按项目统计</h3><p>显示各项目的累计用量、输入与输出拆分；缓存输入属于输入 Token 的子集。</p></div><span className="subtle-count">{data.projects.length} 个项目</span></div>
        {data.projects.length === 0 ? <EmptyState title="没有项目用量" message="当前范围内没有可归入项目的 Token 用量。" /> : <div className="analysis-project-list">
          {data.projects.map((project) => <article className="analysis-project-row" key={project.id}>
            <div className="analysis-project-title"><strong title={project.name}>{project.name}</strong><span>{project.sessionCount} 个会话</span></div>
            <div className="analysis-project-values">
              <span><small>累计 Token</small><strong>{formatTokens(project.totalTokens)}</strong></span>
              <span><small>输入（含缓存）</small><strong>{formatTokens(project.inputTokens)}</strong></span>
              <span><small>缓存输入</small><strong>{formatTokens(project.cachedInputTokens)}</strong></span>
              <span><small>输出</small><strong>{formatTokens(project.outputTokens)}</strong></span>
            </div>
          </article>)}
        </div>}
      </section>
    </>}
  </div>;
}

const tooltipStyle = { background: "var(--tooltip-bg)", border: "1px solid var(--border)", borderRadius: "12px", color: "var(--text)", fontSize: "12px" };
function csvCell(value: unknown): string { const input = String(value ?? ""); return `"${(/^[=+@-]/.test(input) ? `'${input}` : input).replace(/"/g, '""')}"`; }
function download(filename: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadPageSnapshot(): Promise<void> {
  const source = document.documentElement;
  const copy = source.cloneNode(true) as HTMLElement;
  const sourceStyles = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
  const copyStyles = [...copy.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
  for (let index = 0; index < sourceStyles.length; index++) {
    const link = sourceStyles[index]!;
    const response = await fetch(link.href);
    if (!response.ok) throw new Error("无法读取页面样式，HTML 快照未生成。");
    const style = document.createElement("style");
    style.textContent = await response.text();
    copyStyles[index]?.replaceWith(style);
  }
  const liveInputs = [...document.querySelectorAll<HTMLInputElement>("input")];
  const copyInputs = [...copy.querySelectorAll<HTMLInputElement>("input")];
  liveInputs.forEach((input, index) => copyInputs[index]?.setAttribute("value", input.value));
  copy.querySelectorAll("script, link[rel=modulepreload], input[type=file]").forEach((node) => node.remove());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  download(`codex-insight-report-${stamp}.html`, `<!doctype html>\n${copy.outerHTML}`, "text/html;charset=utf-8");
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("codex-insight-theme") === "light" ? "light" : "dark");
  const [timeMode, setTimeMode] = useState<TimeMode>(() => localStorage.getItem("codex-insight-time") === "utc" ? "utc" : "local");
  const [privacyMode, setPrivacyMode] = useState(() => localStorage.getItem("codex-insight-privacy") !== "false");
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<Range>("7d");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [sort, setSort] = useState("activity");
  const [summary, setSummary] = useState<Summary>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionPage, setSessionPage] = useState(1);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [health, setHealth] = useState<Health>();
  const [settings, setSettings] = useState<Settings>({ refreshMs: 3000, sourceMode: "automatic" });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [pollToken, setPollToken] = useState("");
  const browserFileInput = useRef<HTMLInputElement>(null);
  const lastDataVersion = useRef<string | null>(null);
  const lastDataQuery = useRef("");

  const query = useMemo(() => rangeQuery(range, since, until), [range, since, until]);
  const sessionPageCount = Math.max(1, Math.ceil(sessionTotal / 10));
  const loadAll = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const sessionParams = new URLSearchParams(query);
      sessionParams.set("sort", sort);
      sessionParams.set("page", String(sessionPage));
      sessionParams.set("limit", "10");
      if (search.trim()) sessionParams.set("q", search.trim());
      if (projectFilter) sessionParams.set("project", projectFilter);
      if (modelFilter) sessionParams.set("model", modelFilter);
      const dataQueryKey = JSON.stringify([query, sort, search.trim(), projectFilter, modelFilter, sessionPage, rangeRefreshKey(range)]);
      const nextHealth = await api<Health>("/api/health");
      setHealth((previous) => previous
        && previous.dataVersion === nextHealth.dataVersion
        && previous.status === nextHealth.status
        && previous.sessionCount === nextHealth.sessionCount
        && previous.scannedFiles === nextHealth.scannedFiles
        && previous.parseErrors === nextHealth.parseErrors
        && previous.inaccessibleDirectories === nextHealth.inaccessibleDirectories
        && previous.inaccessibleFiles === nextHealth.inaccessibleFiles
        && previous.sourceAvailable === nextHealth.sourceAvailable
        && previous.refreshMs === nextHealth.refreshMs
        ? previous
        : nextHealth);
      const needsDataRefresh = !quiet
        || lastDataVersion.current !== nextHealth.dataVersion
        || lastDataQuery.current !== dataQueryKey;
      if (!needsDataRefresh) { setError(""); return; }
      const [nextSummary, nextSessions, nextProjects, nextModels] = await Promise.all([
        api<Summary>(`/api/summary?${query}`),
        api<SessionPage>(`/api/sessions?${sessionParams.toString()}`),
        api<{ items: ProjectRow[] }>("/api/projects"), api<{ items: ModelRow[] }>("/api/models"),
      ]);
      setSummary(nextSummary); setSessions(nextSessions.items); setSessionTotal(nextSessions.total); setProjects(nextProjects.items); setModels(nextModels.items);
      lastDataVersion.current = nextHealth.dataVersion;
      lastDataQuery.current = dataQueryKey;
      setPollToken(nextHealth.dataVersion); setError("");
    } catch (e) { lastDataVersion.current = null; setError(e instanceof Error ? e.message : "无法连接本地 API"); }
    finally { setLoading(false); setRefreshing(false); }
  }, [query, sort, search, projectFilter, modelFilter, sessionPage]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codex-insight-theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("codex-insight-time", timeMode); }, [timeMode]);
  useEffect(() => { localStorage.setItem("codex-insight-privacy", String(privacyMode)); }, [privacyMode]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const initial = await api<Settings>("/api/settings");
        if (hostedMode) {
          if (alive) { setSettings(initial); setReady(true); }
          return;
        }
        const localSource = localStorage.getItem("codex-insight-source-directory");
        const savedRefresh = Number(localStorage.getItem("codex-insight-refresh-ms"));
        const refreshMs = [2000, 3000, 5000, 10000].includes(savedRefresh) ? savedRefresh : initial.refreshMs;
        const restoreSource = localSource && initial.sourceMode === "automatic";
        if (restoreSource || refreshMs !== initial.refreshMs) {
          const saved = await api<Settings>("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(restoreSource ? { sourceDirectory: localSource } : {}), refreshMs }) });
          if (alive) setSettings(saved);
        } else if (alive) setSettings(initial);
        if (alive) setReady(true);
      } catch (e) {
        if (alive) { setError(e instanceof Error ? e.message : "本地 API 不可用"); setLoading(false); }
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (ready) void loadAll(); }, [ready, loadAll]);
  useEffect(() => { if (sessionPage > sessionPageCount) setSessionPage(sessionPageCount); }, [sessionPage, sessionPageCount]);
  useEffect(() => {
    if (!ready || settings.refreshMs <= 0) return;
    const timer = window.setInterval(() => void loadAll(true), settings.refreshMs);
    return () => window.clearInterval(timer);
  }, [ready, settings.refreshMs, loadAll]);

  const refresh = async () => {
    setRefreshing(true);
    try { await api("/api/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await loadAll(true); }
    catch (e) { setError(e instanceof Error ? e.message : "刷新失败"); setRefreshing(false); }
  };
  const setDateRange = (value: Range) => { setSessionPage(1); setRange(value); if (value === "custom" && !since) setSince(new Date().toISOString().slice(0, 10)); if (value === "custom" && !until) setUntil(new Date().toISOString().slice(0, 10)); };
  const updateSince = (value: string) => { setSessionPage(1); setSince(value); };
  const updateUntil = (value: string) => { setSessionPage(1); setUntil(value); };
  const openSession = (id: string) => { setSelectedId(id); setTab("sessions"); };
  const downloadOverview = (format: "json" | "csv") => {
    if (!hostedMode) { window.location.href = `/api/export?${query}&format=${format}`; return; }
    void api<{ summary: Omit<Summary, "sessionCount" | "scannedFiles" | "parseErrors" | "scannedAt"> }>(`/api/export?${query}&format=${format}`)
      .then(({ summary: data }) => {
        if (format === "json") {
          download("codex-insight-statistics.json", JSON.stringify({ range: data.range, since: data.since, until: data.until, usage: data.usage, cacheHitRate: data.cacheHitRate, apiCost: data.apiCost, daily: data.daily, projects: data.projects, models: data.models, warnings: data.warnings }, null, 2), "application/json");
          return;
        }
        const safe = (value: string | number) => csvCell(value);
        const usageCells = (usage: TokenUsage) => [usage.totalTokens, usage.inputTokens, usage.cachedInputTokens, usage.uncachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens];
        const cacheRate = (usage: TokenUsage) => usage.inputTokens === 0 ? "N/A" : (usage.cachedInputTokens / usage.inputTokens * 100).toFixed(2);
        const uncachedRate = (usage: TokenUsage) => usage.inputTokens === 0 ? "N/A" : (usage.uncachedInputTokens / usage.inputTokens * 100).toFixed(2);
        const lines = ["scope,dimension,date,name,total_tokens,input_tokens,cached_input_tokens,uncached_input_tokens,output_tokens,reasoning_output_tokens,cache_hit_rate,uncached_input_rate,estimated_api_cost_usd,api_pricing_status,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million,session_count"];
        lines.push(["summary", "range", data.since ?? "", data.range, ...usageCells(data.usage), cacheRate(data.usage), uncachedRate(data.usage), data.apiCost.estimatedUsd, data.apiCost.status, "", "", "", ""].map(safe).join(","));
        for (const day of data.daily) lines.push(["daily", "UTC day", day.date, "", ...usageCells(day), cacheRate(day), uncachedRate(day), "", "", "", "", "", ""].map(safe).join(","));
        for (const project of data.projects) lines.push(["project", "project", "", project.name, ...usageCells(project), "", "", "", "", "", "", "", project.sessionCount].map(safe).join(","));
        for (const model of data.models) lines.push(["model", "model", "", model.name, ...usageCells(model), model.cacheHitRate === null ? "N/A" : model.cacheHitRate.toFixed(2), model.uncachedInputRate === null ? "N/A" : model.uncachedInputRate.toFixed(2), model.estimatedApiCostUsd ?? "N/A", model.estimatedApiCostUsd === null ? "unpriced" : "priced", model.apiPricePerMillionUsd?.input ?? "", model.apiPricePerMillionUsd?.cachedInput ?? "", model.apiPricePerMillionUsd?.output ?? "", model.sessionCount].map(safe).join(","));
        download("codex-insight-statistics.csv", `\uFEFF${lines.join("\r\n")}`, "text/csv;charset=utf-8");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "无法导出统计数据"));
  };

  const chooseSource = async () => {
    if (!hostedMode) return;
    if (!supportsDirectoryPicker()) { browserFileInput.current?.click(); return; }
    try {
      await chooseBrowserDirectory();
      setSettings(await api<Settings>("/api/settings"));
      await api("/api/refresh", { method: "POST" });
      await loadAll();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "无法读取所选文件夹");
    }
  };
  const chooseFileSnapshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (!files.length) return;
    try {
      chooseBrowserFiles(files);
      setSettings(await api<Settings>("/api/settings"));
      await api("/api/refresh", { method: "POST" });
      await loadAll();
    } catch (e) { setError(e instanceof Error ? e.message : "无法读取所选文件夹"); }
  };

  const saveSettings = async (input: { refreshMs: number; sourceDirectory?: string; useAutomatic?: boolean }) => {
    const next = await api<Settings>("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    setSettings(next);
    localStorage.setItem("codex-insight-refresh-ms", String(input.refreshMs));
    if (input.useAutomatic) localStorage.removeItem("codex-insight-source-directory");
    if (input.sourceDirectory) localStorage.setItem("codex-insight-source-directory", input.sourceDirectory);
    await loadAll(true);
  };

  const dashboardSummary = summary;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand topbar-brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>Codex Insight</strong><small>本地 Token 分析</small></div></div>
      <nav className="main-nav" aria-label="主导航">
        <button className={tab === "overview" ? "active" : ""} onClick={() => { setSelectedId(undefined); setTab("overview"); }}><span className="nav-icon">◫</span>概览</button>
        <button className={tab === "sessions" ? "active" : ""} onClick={() => { setSelectedId(undefined); setTab("sessions"); }}><span className="nav-icon">◷</span>会话 <span className="nav-count">{health?.sessionCount ?? "—"}</span></button>
        <button className={tab === "analysis" ? "active" : ""} onClick={() => { setSelectedId(undefined); setTab("analysis"); }}><span className="nav-icon">▥</span>用量分析</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => { setSelectedId(undefined); setTab("settings"); }}><span className="nav-icon">⚙</span>设置</button>
      </nav>
      <div className="topbar-actions">
        <div className="connection-status"><i className={health?.sourceAvailable ? "" : "warning"} /><span>{health?.sourceAvailable ? hostedMode ? settings.sourceMode === "snapshot" ? "本地文件快照" : "浏览器本地实时扫描" : "本地数据实时更新" : hostedMode ? "请选择会话文件夹" : "请检查数据源"}</span></div>
        {hostedMode && <button className="button secondary" onClick={() => void chooseSource()}>{health?.sourceAvailable ? "更换文件夹" : "选择文件夹"}</button>}
        <button className="icon-button" title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☼" : "☾"}</button>
        <button className={`button refresh-button ${refreshing ? "is-refreshing" : ""}`} onClick={() => void refresh()} disabled={refreshing}><span>↻</span>{refreshing ? "刷新中" : "刷新"}</button>
      </div>
    </header>
    {hostedMode && <input ref={(element) => { browserFileInput.current = element; element?.setAttribute("webkitdirectory", ""); element?.setAttribute("directory", ""); }} type="file" multiple hidden onChange={(event) => void chooseFileSnapshot(event)} />}

    <main className="main-area">
      <div className="content-area">
        {error && <div className="error-banner"><span>!</span><div><strong>本地服务提示</strong><small>{localizeMessage(error)}</small></div><button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}

        {tab === "overview" && <>
          <section className="page-heading overview-heading">
            <div><div className="eyebrow">CODEX 用量 · 隐私优先</div><div className="overview-title-row"><h1>用量概览</h1><DataWarningInfo warnings={dashboardSummary?.warnings ?? []} /></div><p>直接统计本地 Codex 会话日志中的累计 Token。</p></div>
            <div className="heading-meta"><span><i className="live-dot" />{settings.refreshMs > 0 ? `每 ${settings.refreshMs / 1000} 秒自动检查` : "文件夹快照 · 重新选择以更新"}</span><small>最近数据更新：{formatTime(health?.scannedAt, timeMode)}</small></div>
          </section>
          {hostedMode && !health?.sourceAvailable && <div className="callout-note"><span>ⓘ</span><p>先选择 Codex 的 <code>.codex</code> 文件夹或其中的 <code>sessions</code> 文件夹。日志会留在你的设备上，由浏览器本地统计。</p><button className="button primary" onClick={() => void chooseSource()}>选择会话文件夹</button></div>}
          <section className="toolbar-row">
            <RangeControl value={range} onChange={setDateRange} since={since} until={until} setSince={updateSince} setUntil={updateUntil} />
            <div className="export-actions"><button className="button secondary" onClick={() => void downloadPageSnapshot().catch((e) => setError(e instanceof Error ? e.message : "无法生成 HTML 快照"))}>↓ 保存 HTML 快照</button><button className="button secondary" onClick={() => downloadOverview("csv")}>↓ 导出 CSV</button><button className="button secondary" onClick={() => downloadOverview("json")}>↓ 导出 JSON</button></div>
          </section>
          {loading && !dashboardSummary ? <div className="loading-panel"><span className="spinner" /> 正在读取本地会话统计…</div> : dashboardSummary && <>
            <div className="metric-grid overview-metrics">
              {metrics.map((metric) => <StatCard key={metric.key} label={metric.label} value={formatTokens(dashboardSummary.usage[metric.key])} hint={metric.hint} color={metric.color} />)}
              <StatCard label="缓存命中率" value={formatRate(dashboardSummary.cacheHitRate)} hint="缓存输入 Token ÷ 输入 Token；输入为 0 时不适用。" color="green" footnote="缓存输入 ÷ 输入" />
              <StatCard label="API 价等值" value={dashboardSummary.apiCost.pricedModelCount === 0 ? "无匹配价格" : `≈ ${formatUsd(dashboardSummary.apiCost.estimatedUsd)}`} hint="按官网标准短上下文 API 单价估算，美元计价；不代表 Codex 订阅费用或实际 API 账单。未匹配模型不计入小计。" color="blue" footnote={`${dashboardSummary.apiCost.pricedModelCount}/${dashboardSummary.apiCost.totalModelCount} 个模型匹配 · USD`} />
            </div>
            <div className="callout-note pricing-note"><span>ⓘ</span><p><strong>API 价格等值估算，不是实际账单。</strong>按官网标准短上下文 API 单价（USD/百万 Token）计算：(未缓存输入 × 输入价 + 缓存输入 × 缓存价 + 输出 × 输出价) ÷ 1,000,000；推理 Token 已包含在输出中。未匹配价格的模型不计入小计；日志没有逐请求上下文长度及工具费用，因此不会估算长上下文倍率、缓存写入和工具附加费。价格核对于 {dashboardSummary.apiCost.checkedOn}，<a href={dashboardSummary.apiCost.sourceUrl} target="_blank" rel="noreferrer">查看 OpenAI 官网价格 ↗</a>。Codex 订阅用量不等于 API 账单。</p></div>
            <div className="overview-grid">
              <section className="panel usage-panel">
                <div className="panel-heading"><div><h3>每日用量</h3><p>按缓存输入、未缓存输入和输出堆叠显示 · 按 UTC 日期统计</p></div><span className="chart-total">{formatShort(dashboardSummary.usage.totalTokens)}<small>所选范围内的 Token</small></span></div>
                {dashboardSummary.daily.length === 0 ? <EmptyState title="此范围内没有用量" message="选择其他时间范围，或继续使用 Codex 以查看每日统计。" /> : <div className="chart-frame usage-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={dashboardSummary.daily} margin={{ top: 14, right: 8, bottom: 4, left: 8 }} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 6" vertical={false} stroke="var(--grid)" /><XAxis dataKey="date" tickFormatter={localDay} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} minTickGap={28} /><YAxis tickFormatter={formatShort} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={48} /><Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => localDay(String(value))} formatter={(value, name) => [formatTokens(Number(value)), name]} /><Bar dataKey="cachedInputTokens" stackId="usage" name="缓存输入" fill="#56b6d9" radius={[0, 0, 0, 0]} /><Bar dataKey="uncachedInputTokens" stackId="usage" name="未缓存输入" fill="#8277ee" /><Bar dataKey="outputTokens" stackId="usage" name="输出" fill="#f3a66b" radius={[4, 4, 0, 0]} />
                </BarChart></ResponsiveContainer></div>}
                <div className="chart-legend"><span><i className="legend-cached" />缓存输入</span><span><i className="legend-uncached" />未缓存输入</span><span><i className="legend-output" />输出 <small>含推理 Token</small></span></div>
              </section>
              <section className="panel pulse-panel">
                <div className="panel-heading"><div><h3>数据状态</h3><p>最近一次本地扫描</p></div><span className={`health-mark ${health?.status === "ok" ? "healthy" : "needs-review"}`}>{health?.status === "ok" ? "✓" : "!"}</span></div>
                <div className="health-stat"><strong>{health?.sessionCount ?? 0}</strong><span>个会话</span></div>
                <div className="health-rows"><div><span>会话日志文件</span><strong>{health?.scannedFiles ?? 0}</strong></div><div><span>格式错误的行</span><strong className={health?.parseErrors ? "warn-text" : ""}>{health?.parseErrors ?? 0}</strong></div><div><span>数据源</span><strong>{health?.sourceAvailable ? "可用" : "不可用"}</strong></div></div>
                <button className="text-action" onClick={() => setTab("settings")}>管理数据源 <span>→</span></button>
              </section>
            </div>
            <div className="breakdown-grid">
              <Breakdown title="按模型统计" subtitle="Token 用量、缓存比例与 API 价等值" headers={["模型", "TOKEN / USD"]} rows={dashboardSummary.models.map((row) => ({ id: row.name, name: row.name, usage: row, sessions: row.sessionCount, cacheHitRate: row.cacheHitRate, uncachedInputRate: row.uncachedInputRate, estimatedApiCostUsd: row.estimatedApiCostUsd, apiPricePerMillionUsd: row.apiPricePerMillionUsd }))} onSelect={(model) => { setSessionPage(1); setModelFilter(model); setProjectFilter(""); setTab("sessions"); }} />
              <Breakdown title="按项目统计" subtitle="显示项目名称，不显示完整路径" headers={["项目", "TOKEN"]} rows={dashboardSummary.projects.map((row) => ({ id: row.id, name: row.name, usage: row, sessions: row.sessionCount }))} onSelect={(id) => { setSessionPage(1); setProjectFilter(id); setModelFilter(""); setTab("sessions"); }} />
            </div>
            <section className="panel recent-panel">
              <div className="panel-heading"><div><h3>最近会话</h3><p>最近的 Codex 活动</p></div><button className="text-action" onClick={() => { setSelectedId(undefined); setTab("sessions"); }}>查看全部会话 <span>→</span></button></div>
              <SessionTable items={sessions} onSelect={openSession} timeMode={timeMode} compact />
            </section>
          </>}
        </>}

        {tab === "sessions" && (selectedId ? <SessionDetail sessionId={selectedId} timeMode={timeMode} privacyMode={privacyMode} pollToken={pollToken} onClose={() => setSelectedId(undefined)} /> : <>
          <section className="page-heading sessions-heading"><div><div className="eyebrow">会话列表</div><h1>全部会话</h1><p>搜索并比较本地会话中的累计 Token 用量。</p></div><span className="session-total">共 {sessionTotal} 个会话</span></section>
          <section className="panel session-browser">
            <div className="session-filters">
              <label className="search-field"><span>⌕</span><input value={search} onChange={(e) => { setSessionPage(1); setSearch(e.target.value); }} placeholder="搜索会话名称、ID、项目或模型…" /></label>
              <select className="select-control" value={projectFilter} onChange={(e) => { setSessionPage(1); setProjectFilter(e.target.value); }}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
              <select className="select-control" value={modelFilter} onChange={(e) => { setSessionPage(1); setModelFilter(e.target.value); }}><option value="">全部模型</option>{models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}</select>
              <select className="select-control sort-select" value={sort} onChange={(e) => { setSessionPage(1); setSort(e.target.value); }}><option value="activity">最近活动</option><option value="total">累计 Token 最多</option><option value="output">输出 Token 最多</option></select>
            </div>
            <div className="list-range"><RangeControl value={range} onChange={setDateRange} since={since} until={until} setSince={updateSince} setUntil={updateUntil} /></div>
            {loading && !sessions.length ? <div className="loading-panel"><span className="spinner" /> 正在加载会话…</div> : <SessionTable items={sessions} onSelect={openSession} timeMode={timeMode} />}
            <div className="table-footer">
              <span>{sessionTotal === 0 ? "没有符合条件的会话" : `显示 ${(sessionPage - 1) * 10 + 1}–${Math.min(sessionPage * 10, sessionTotal)} 条，共 ${sessionTotal} 条`} · 排序：{sort === "activity" ? "最近活动" : sort === "total" ? "累计 Token" : "输出 Token"}</span>
              <div className="table-pagination" aria-label="会话列表分页">
                <button className="button secondary" onClick={() => setSessionPage((page) => Math.max(1, page - 1))} disabled={sessionPage <= 1}>上一页</button>
                <span>第 {sessionPage} / {sessionPageCount} 页</span>
                <button className="button secondary" onClick={() => setSessionPage((page) => Math.min(sessionPageCount, page + 1))} disabled={sessionPage >= sessionPageCount}>下一页</button>
              </div>
              <button className="button secondary" onClick={() => downloadOverview("csv")}>↓ 导出此范围</button>
            </div>
          </section>
        </>)}

        {tab === "analysis" && <UsageAnalysis timeMode={timeMode} pollToken={pollToken} />}
        {tab === "settings" && <SettingsView settings={settings} theme={theme} timeMode={timeMode} privacyMode={privacyMode} hostedMode={hostedMode} onPickSource={() => void chooseSource()} onTheme={setTheme} onTimeMode={setTimeMode} onPrivacyMode={setPrivacyMode} onSave={saveSettings} />}
      </div>
      <footer className="app-footer"><span>Codex Insight <i>·</i> 本地优先的会话分析</span><span>已读取文件：{health?.scannedFiles ?? 0} <i>·</i> 最近数据更新：{formatTime(health?.scannedAt, timeMode)}</span></footer>
    </main>
  </div>;
}

function SettingsView({ settings, theme, timeMode, privacyMode, hostedMode, onPickSource, onTheme, onTimeMode, onPrivacyMode, onSave }: {
  settings: Settings; theme: Theme; timeMode: TimeMode; privacyMode: boolean;
  hostedMode: boolean; onPickSource: () => void;
  onTheme: (theme: Theme) => void; onTimeMode: (mode: TimeMode) => void; onPrivacyMode: (enabled: boolean) => void;
  onSave: (input: { refreshMs: number; sourceDirectory?: string; useAutomatic?: boolean }) => Promise<void>;
}) {
  const [directory, setDirectory] = useState("");
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [refreshMs, setRefreshMs] = useState(settings.refreshMs);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setRefreshMs(settings.refreshMs), [settings.refreshMs]);

  const revealCurrent = async () => {
    try {
      const data = await api<{ sourceDirectory?: string }>("/api/settings?revealPath=1");
      setCurrentDirectory(data.sourceDirectory ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : "无法显示路径"); }
  };
  const submit = async (automatic = false) => {
    setSaving(true); setError(""); setMessage("");
    try {
      if (!automatic && directory.trim()) await onSave({ refreshMs, sourceDirectory: directory.trim() });
      else await onSave({ refreshMs, ...(automatic ? { useAutomatic: true } : {}) });
      setDirectory(""); setMessage(automatic ? "已切换为自动发现的 Codex 会话目录。" : "设置已保存，本地扫描器正在使用所选文件夹。");
      setCurrentDirectory("");
    } catch (e) { setError(e instanceof Error ? e.message : "无法保存设置"); }
    finally { setSaving(false); }
  };

  return <>
    <section className="page-heading settings-heading"><div><div className="eyebrow">偏好设置</div><h1>设置</h1><p>管理本地扫描、刷新频率以及 Dashboard 的显示方式。</p></div></section>
    <div className="settings-layout">
      <div className="settings-main">
        <section className="panel settings-card">
          <div className="settings-section-title"><span className="settings-icon">▱</span><div><h3>会话数据源</h3><p>仅递归扫描所选文件夹中符合条件的 rollout JSONL 文件。</p></div></div>
          {hostedMode ? <div className="source-current"><span className={`source-indicator ${settings.sourceMode === "browser" && !settings.sourceDirectory ? "custom" : "ready"}`} /><div><strong>{settings.sourceDirectory ? `已授权：${settings.sourceDirectory}` : settings.sourceMode === "snapshot" ? "已选择文件夹快照" : "尚未选择本地文件夹"}</strong><small>{settings.sourceMode === "snapshot" ? "此浏览器不支持实时目录权限；重新选择文件夹以读取新日志。" : "所选日志只在此浏览器中读取，原始日志不会发送到托管服务器。"}</small></div><button className="button primary" onClick={onPickSource}>{settings.sourceDirectory || settings.sourceMode === "snapshot" ? "更换文件夹" : "选择文件夹"}</button></div>
            : <>
              <div className="source-current"><span className={`source-indicator ${settings.sourceMode === "automatic" ? "ready" : "custom"}`} /><div><strong>{settings.sourceMode === "automatic" ? "自动发现" : "已选择自定义文件夹"}</strong><small>{settings.sourceMode === "automatic" ? "CODEX_HOME/sessions 或 ~/.codex/sessions" : "出于隐私考虑，完整路径已隐藏"}</small></div><button className="text-action" onClick={() => void revealCurrent()}>显示路径 <span>⌄</span></button></div>
              {currentDirectory && <div className="revealed-path">{currentDirectory}<button onClick={() => setCurrentDirectory("")} aria-label="隐藏路径">×</button></div>}
              <label className="form-label" htmlFor="source-path">使用其他会话文件夹</label>
              <div className="path-form"><input id="source-path" value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="粘贴本地文件夹的绝对路径" /><button className="button primary" onClick={() => void submit()} disabled={saving || !directory.trim()}>{saving ? "正在保存…" : "使用此文件夹"}</button></div>
              <div className="form-help">示例：<code>C:\Users\you\.codex\sessions</code>。文件夹必须已存在。自定义文件夹选择会保存在此浏览器中。</div>
              <div className="settings-separator" />
              <div className="source-current automatic-row"><span className="auto-icon">↺</span><div><strong>恢复自动发现</strong><small>使用此电脑配置的默认文件夹。</small></div><button className="button secondary" onClick={() => void submit(true)} disabled={saving}>使用默认目录</button></div>
            </>}
        </section>

        {settings.sourceMode !== "snapshot" && <section className="panel settings-card">
          <div className="settings-section-title"><span className="settings-icon">◷</span><div><h3>刷新间隔</h3><p>扫描器会按此频率检查文件追加和变更。</p></div></div>
          <div className="refresh-options">{[2000, 3000, 5000, 10000].map((value) => <button key={value} className={refreshMs === value ? "selected" : ""} onClick={() => setRefreshMs(value)}><strong>{value / 1000}s</strong><small>{value === 3000 ? "推荐" : value === 2000 ? "快速" : value === 5000 ? "均衡" : "省资源"}</small></button>)}</div>
          <div className="settings-save-row"><span>此刷新间隔同时用于日志扫描和 Dashboard 数据刷新。</span><button className="button primary" onClick={() => void submit()} disabled={saving}>{saving ? "正在保存…" : "保存间隔"}</button></div>
        </section>}

        <section className="panel settings-card">
          <div className="settings-section-title"><span className="settings-icon">◐</span><div><h3>外观</h3><p>这些偏好设置保存在此浏览器中。</p></div></div>
          <div className="preference-row"><div><strong>主题</strong><small>选择 Dashboard 的配色方案。</small></div><div className="segmented-control small-segment"><button className={theme === "dark" ? "selected" : ""} onClick={() => onTheme("dark")}>深色</button><button className={theme === "light" ? "selected" : ""} onClick={() => onTheme("light")}>浅色</button></div></div>
          <div className="preference-row"><div><strong>时间显示</strong><small>跨设备对比日志时间戳时，使用 UTC 更方便。</small></div><div className="segmented-control small-segment"><button className={timeMode === "local" ? "selected" : ""} onClick={() => onTimeMode("local")}>本地时间</button><button className={timeMode === "utc" ? "selected" : ""} onClick={() => onTimeMode("utc")}>UTC</button></div></div>
        </section>
      </div>
      <aside className="settings-aside">
        <section className="panel privacy-card"><div className="privacy-symbol">⌑</div><div className="eyebrow">本地隐私</div><h3>你的数据由你掌控。</h3><p>Codex Insight 从本地日志读取 Token 快照和会话元数据，不会将数据发送到远程服务。</p>
          <div className="privacy-toggle-row"><div><strong>隐藏完整路径</strong><small>默认隐私模式</small></div><button role="switch" aria-checked={privacyMode} className={`toggle-switch ${privacyMode ? "on" : ""}`} onClick={() => onPrivacyMode(!privacyMode)}><i /></button></div>
          <ul><li>不会展示或导出提示词与工具输出。</li><li>{hostedMode ? "统计在浏览器本机完成，日志内容不会上传。" : "本地 API 仅监听 127.0.0.1。"}</li><li>项目名称和会话 ID 仍可能包含敏感信息。</li></ul>
        </section>
        <section className="panel about-card"><div className="eyebrow">統計口径说明</div><p><strong>累计 Token</strong> 使用日志报告的累计总量，通常等于输入 + 输出。</p><p><strong>缓存命中率</strong>为缓存输入 ÷ 输入；输入为 0 时不适用。</p><p><strong>推理 Token</strong> 已包含在输出中，不会再次累加。</p><p><strong>上下文窗口占用</strong>不会根据累计 Token 推算。</p></section>
      </aside>
    </div>
    {message && <div className="toast success-toast">✓ {message}</div>}{error && <div className="toast error-toast">! {localizeMessage(error)}</div>}
  </>;
}
