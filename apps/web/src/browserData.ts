import {
  addApiPriceEstimates, addUsage, aggregateSession, emptyScanResult, parseJsonlLine, ZERO_USAGE,
  type LogEvent, type ScanResult, type SessionSummary, type TimeRange, type TokenUsage, type UsagePoint,
} from "@codex-insight/core/browser";
import type { TimedEvent } from "@codex-insight/core/browser";

type DirectoryEntry = FileHandle | DirectoryHandle;
type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };
type DirectoryHandle = {
  kind: "directory"; name: string;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
  values(): AsyncIterable<DirectoryEntry>;
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
};
type DirectoryPickerWindow = Window & { showDirectoryPicker?: (options?: { id?: string; mode?: "read" }) => Promise<DirectoryHandle> };
type SourceFile = { path: string; file: File };
type FileState = {
  observedSize: number; readOffset: number; mtimeMs: number; tail: Uint8Array; anchor: Uint8Array;
  events: Array<{ event: LogEvent; line: number }>; parseErrors: number; lineNumber: number; warnings: string[];
};
type RangeQuery = { range?: string; since?: string; until?: string };
type RangeBounds = { start?: number; end?: number; label: TimeRange };
type SourceMode = "browser" | "snapshot";

const ACTIVE_WINDOW_MS = 15_000;
const defaultRefreshMs = 3_000;
const allowedRefreshMs = new Set([2_000, 3_000, 5_000, 10_000]);

function zero(): TokenUsage { return { ...ZERO_USAGE }; }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a); result.set(b, a.length);
  return result;
}
function basename(value: string): string { return value.split(/[\\/]/).at(-1) ?? value; }
function idFromPath(value: string): string {
  const name = basename(value).replace(/\.jsonl$/i, "");
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? name;
}
function projectName(projectPath?: string): string { return projectPath ? basename(projectPath.replace(/[\\/]$/, "")) || "Unknown project" : "Unknown project"; }
function projectKey(projectPath?: string): string {
  if (!projectPath) return "unknown";
  let hash = 0x811c9dc5;
  const canonical = /^[a-z]:[\\/]/i.test(projectPath) ? projectPath.toLowerCase() : projectPath;
  for (const codePoint of canonical) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseBound(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
function rangeBounds(query: RangeQuery, now = new Date()): RangeBounds {
  if (query.range === "today") return { start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()), end: now.getTime(), label: "today" };
  if (query.range === "7d" || query.range === "30d") return { start: now.getTime() - (query.range === "7d" ? 7 : 30) * 86_400_000, end: now.getTime(), label: query.range };
  if (query.range === "custom") return { start: parseBound(query.since), end: parseBound(query.until), label: "custom" };
  return { label: "all" };
}
function inBounds(point: UsagePoint, bounds: RangeBounds): boolean {
  if (!point.timestamp) return bounds.label === "all";
  const time = Date.parse(point.timestamp);
  return (bounds.start === undefined || time >= bounds.start) && (bounds.end === undefined || time <= bounds.end);
}
function addTo(map: Map<string, TokenUsage>, key: string, value: TokenUsage): void { map.set(key, addUsage(map.get(key) ?? zero(), value)); }

function summarizeRange(scan: ScanResult, query: RangeQuery = {}, now = new Date()) {
  const bounds = rangeBounds(query, now);
  const usage = zero();
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
    const selected = bounds.label === "all" ? session.usage : included.reduce((total, point) => addUsage(total, point.delta), zero());
    Object.assign(usage, addUsage(usage, selected));
    const key = projectKey(session.projectPath);
    const project = projects.get(key) ?? { name: projectName(session.projectPath), usage: zero(), sessions: new Set<string>() };
    project.usage = addUsage(project.usage, selected);
    if (Object.values(selected).some((value) => value > 0) || session.timeline.some((point) => inBounds(point, bounds))) project.sessions.add(session.id);
    projects.set(key, project);
    if (bounds.label === "all") {
      for (const [name, value] of Object.entries(session.perModel)) {
        const model = models.get(name) ?? { usage: zero(), sessions: new Set<string>() };
        model.usage = addUsage(model.usage, value);
        if (Object.values(value).some((count) => count > 0)) model.sessions.add(session.id);
        models.set(name, model);
      }
    } else {
      for (const point of included) {
        const name = point.model ?? (session.modelNames.length > 1 ? "Mixed / unknown" : session.modelNames[0] ?? "Unknown");
        const model = models.get(name) ?? { usage: zero(), sessions: new Set<string>() };
        model.usage = addUsage(model.usage, point.delta);
        if (Object.values(point.delta).some((count) => count > 0)) model.sessions.add(session.id);
        models.set(name, model);
      }
    }
    for (const point of included) {
      if (!point.timestamp) continue;
      const time = new Date(point.timestamp);
      if (Number.isFinite(time.getTime())) addTo(days, time.toISOString().slice(0, 10), point.delta);
    }
  }
  const priced = addApiPriceEstimates([...models.entries()].map(([name, model]) => ({ name, ...model.usage, sessionCount: model.sessions.size }))
    .sort((a, b) => b.totalTokens - a.totalTokens));
  return {
    range: bounds.label,
    since: bounds.start === undefined ? undefined : new Date(bounds.start).toISOString(),
    until: bounds.end === undefined ? undefined : new Date(bounds.end).toISOString(),
    usage, cacheHitRate: usage.inputTokens === 0 ? null : usage.cachedInputTokens / usage.inputTokens * 100,
    daily: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, ...value })),
    projects: [...projects.entries()].map(([id, item]) => ({ id, name: item.name, ...item.usage, sessionCount: item.sessions.size })).sort((a, b) => b.totalTokens - a.totalTokens),
    models: priced.models, apiCost: priced.apiCost, warnings: [...warnings],
  };
}

function sessionDto(session: SessionSummary, includePath = false) {
  const modelNames = session.modelNames;
  return {
    id: session.id, title: session.title, startedAt: session.startedAt, updatedAt: session.updatedAt,
    projectKey: projectKey(session.projectPath), projectName: projectName(session.projectPath), modelNames,
    modelLabel: modelNames.length > 1 ? "Mixed models" : modelNames[0] ?? "Unknown", usage: session.usage,
    cacheHitRate: session.cacheHitRate, warnings: session.warnings, confidence: session.confidence,
    isUpdating: session.isUpdating, eventCount: session.eventCount,
    ...(includePath ? { projectPath: session.projectPath, logPaths: session.logPaths ?? [] } : {}),
  };
}
function inDateRange(session: SessionSummary, query: RangeQuery, now = new Date()): boolean {
  const bounds = rangeBounds(query, now);
  if (bounds.label === "all") return true;
  if (!session.updatedAt) return false;
  const time = Date.parse(session.updatedAt);
  return (bounds.start === undefined || time >= bounds.start) && (bounds.end === undefined || time <= bounds.end);
}
function sortSession(a: SessionSummary, b: SessionSummary, sort: string): number {
  if (sort === "total") return b.usage.totalTokens - a.usage.totalTokens;
  if (sort === "output") return b.usage.outputTokens - a.usage.outputTokens;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

class BrowserSessionScanner {
  private directory?: DirectoryHandle;
  private selectedFiles?: File[];
  private fileStates = new Map<string, FileState>();
  private result: ScanResult = emptyScanResult();
  private cachedSessions: SessionSummary[] = [];
  private version = 0;
  private names = new Map<string, string>();
  private nameIndexStamp = "";
  private pending?: Promise<ScanResult>;

  get current(): ScanResult { return this.result; }
  get sourceMode(): SourceMode | undefined { return this.directory ? "browser" : this.selectedFiles ? "snapshot" : undefined; }
  get sourceName(): string | undefined { return this.directory?.name; }

  setDirectory(handle: DirectoryHandle): void {
    this.directory = handle; this.selectedFiles = undefined; this.fileStates.clear(); this.cachedSessions = []; this.names.clear(); this.nameIndexStamp = "";
    this.result = emptyScanResult(); this.version++;
  }
  setFiles(files: File[]): void {
    this.directory = undefined; this.selectedFiles = files; this.fileStates.clear(); this.cachedSessions = []; this.names.clear(); this.nameIndexStamp = "";
    this.result = emptyScanResult(); this.version++;
  }

  scan(): Promise<ScanResult> {
    if (this.pending) return this.pending;
    this.pending = this.scanInternal().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async discover(): Promise<{ files: SourceFile[]; indexDirectory?: DirectoryHandle; indexFile?: File; errors: string[] }> {
    const found: SourceFile[] = [];
    const errors: string[] = [];
    if (this.selectedFiles) {
      let indexFile: File | undefined;
      for (const file of this.selectedFiles) {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        if (/^rollout-.*\.jsonl$/i.test(basename(relative))) found.push({ path: relative, file });
        if (basename(relative) === "session_index.jsonl") indexFile = file;
      }
      return { files: found, indexFile, errors };
    }
    if (!this.directory) return { files: found, errors };

    let scanRoot = this.directory;
    let indexDirectory = this.directory;
    try {
      const sessions = await this.directory.getDirectoryHandle("sessions");
      scanRoot = sessions;
    } catch { /* A selected sessions folder is also a valid root. */ }
    const visit = async (directory: DirectoryHandle, prefix: string): Promise<void> => {
      try {
        for await (const entry of directory.values()) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.kind === "directory") await visit(entry, relative);
          else if (entry.kind === "file" && /^rollout-.*\.jsonl$/i.test(entry.name)) {
            try { found.push({ path: relative, file: await entry.getFile() }); }
            catch (error) { errors.push(`Cannot read a session log file (${error instanceof Error ? error.message : "permission denied"})`); }
          }
        }
      } catch (error) { errors.push(`Cannot read a session directory (${error instanceof Error ? error.message : "permission denied"})`); }
    };
    await visit(scanRoot, scanRoot === this.directory ? "" : "sessions");
    if (scanRoot !== this.directory) indexDirectory = this.directory;
    return { files: found, indexDirectory, errors };
  }

  private async readNames(indexDirectory?: DirectoryHandle, indexFile?: File): Promise<Map<string, string>> {
    if (!indexDirectory && !indexFile) {
      this.names = new Map(); this.nameIndexStamp = "";
      return this.names;
    }
    try {
      const file = indexFile ?? await (await indexDirectory!.getFileHandle("session_index.jsonl")).getFile();
      const stamp = `${file.size}:${file.lastModified}`;
      if (stamp === this.nameIndexStamp) return this.names;
      const names = new Map<string, string>();
      for (const line of (await file.text()).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          if (typeof row.id === "string" && typeof row.thread_name === "string" && row.thread_name.trim()) names.set(row.id, row.thread_name.trim());
        } catch { /* Optional title metadata does not affect token scanning. */ }
      }
      this.names = names; this.nameIndexStamp = stamp;
      return names;
    } catch { return new Map(); }
  }

  private async updateFile(path: string, file: File): Promise<boolean> {
    let state = this.fileStates.get(path);
    let changed = false;
    if (!state) {
      state = { observedSize: 0, readOffset: 0, mtimeMs: 0, tail: new Uint8Array(), anchor: new Uint8Array(), events: [], parseErrors: 0, lineNumber: 0, warnings: [] };
      this.fileStates.set(path, state); changed = true;
    }
    const completeEnd = state.readOffset - state.tail.length;
    const anchorStart = Math.max(0, completeEnd - state.anchor.length);
    const currentAnchor = new Uint8Array(await file.slice(anchorStart, completeEnd).arrayBuffer());
    const replaced = state.anchor.length > 0 && !sameBytes(state.anchor, currentAnchor);
    const truncated = file.size < state.readOffset;
    const sameSizeRewrite = state.observedSize === file.size && state.mtimeMs !== 0 && file.lastModified !== state.mtimeMs;
    if (replaced || truncated || sameSizeRewrite) {
      state.warnings.push("Log file was truncated or replaced; earlier snapshots from that file were discarded");
      state.observedSize = 0; state.readOffset = 0; state.mtimeMs = 0; state.tail = new Uint8Array(); state.anchor = new Uint8Array();
      state.events = []; state.parseErrors = 0; state.lineNumber = 0; changed = true;
    }
    if (file.size > state.readOffset) {
      const appended = new Uint8Array(await file.slice(state.readOffset).arrayBuffer());
      const bytes = concatBytes(state.tail, appended);
      let lineStart = 0;
      const decoder = new TextDecoder();
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 0x0a) continue;
        let line = decoder.decode(bytes.subarray(lineStart, index));
        if (line.endsWith("\r")) line = line.slice(0, -1);
        lineStart = index + 1;
        state.lineNumber++;
        if (!line.trim()) continue;
        const parsed = parseJsonlLine(line);
        if (parsed.error) state.parseErrors++;
        else if (parsed.event) { state.events.push({ event: parsed.event, line: state.lineNumber }); changed = true; }
      }
      state.tail = bytes.slice(lineStart);
      state.readOffset = file.size;
    }
    state.observedSize = file.size; state.mtimeMs = file.lastModified;
    const nextCompleteEnd = state.readOffset - state.tail.length;
    const nextAnchorStart = Math.max(0, nextCompleteEnd - 256);
    state.anchor = new Uint8Array(await file.slice(nextAnchorStart, nextCompleteEnd).arrayBuffer());
    return changed;
  }

  private async scanInternal(): Promise<ScanResult> {
    const scannedAt = new Date();
    if (!this.directory && !this.selectedFiles) return this.result;
    const discovered = await this.discover();
    let changed = false;
    const paths = new Set(discovered.files.map((item) => item.path));
    for (const path of this.fileStates.keys()) if (!paths.has(path)) { this.fileStates.delete(path); changed = true; }
    let inaccessibleFiles = discovered.errors.filter((message) => message.includes("log file")).length;
    for (const item of discovered.files) {
      try { changed = (await this.updateFile(item.path, item.file)) || changed; }
      catch { inaccessibleFiles++; }
    }
    const priorNames = new Map(this.names);
    const sessionNames = await this.readNames(discovered.indexDirectory, discovered.indexFile);
    if (sessionNames.size !== priorNames.size || [...sessionNames].some(([key, value]) => priorNames.get(key) !== value)) changed = true;
    const parseErrors = [...this.fileStates.values()].reduce((total, state) => total + state.parseErrors, 0);
    const warnings = [...discovered.errors.filter((message) => message.includes("directory"))];
    if (parseErrors) warnings.push(`${parseErrors} malformed JSONL line(s) skipped`);
    if (inaccessibleFiles) warnings.push(`${inaccessibleFiles} matching session log file(s) could not be read`);
    if (warnings.length !== this.result.warnings.length || warnings.some((warning, index) => warning !== this.result.warnings[index])
      || inaccessibleFiles !== this.result.inaccessibleFiles || parseErrors !== this.result.parseErrors) changed = true;
    if (this.cachedSessions.some((session) => {
      const isUpdating = (session.logPaths ?? []).some((path) => {
        const state = this.fileStates.get(path);
        return !!state && state.mtimeMs > 0 && scannedAt.getTime() - state.mtimeMs <= ACTIVE_WINDOW_MS;
      });
      return isUpdating !== session.isUpdating;
    })) changed = true;
    if (changed) {
      const grouped = new Map<string, TimedEvent[]>();
      let order = 0;
      for (const [path, state] of this.fileStates) {
        const meta = state.events.find((row) => row.event.kind === "meta" && row.event.sessionId);
        const id = meta?.event.kind === "meta" ? meta.event.sessionId! : idFromPath(path);
        const rows = grouped.get(id) ?? [];
        for (const row of state.events) rows.push({ ...row, file: path, order: order++ });
        grouped.set(id, rows);
      }
      this.cachedSessions = [...grouped.entries()].map(([id, rows]) => {
        const files = [...new Set(rows.map((row) => row.file))];
        const isUpdating = files.some((path) => {
          const state = this.fileStates.get(path);
          return !!state && state.mtimeMs > 0 && scannedAt.getTime() - state.mtimeMs <= ACTIVE_WINDOW_MS;
        });
        const summary = aggregateSession(id, rows, isUpdating);
        const title = sessionNames.get(id);
        if (title) summary.title = title;
        summary.logPaths = files.sort();
        const sourceWarnings = new Set(rows.flatMap((row) => this.fileStates.get(row.file)?.warnings ?? []));
        if (!rows.some((row) => row.event.kind === "meta" && !!row.event.sessionId)) sourceWarnings.add("Session metadata ID is missing; this session is grouped by its log filename");
        const malformedFiles = new Set(rows.filter((row) => this.fileStates.get(row.file)?.parseErrors).map((row) => row.file));
        if (malformedFiles.size) sourceWarnings.add(`${malformedFiles.size} session log file(s) contained malformed JSONL lines`);
        if (sourceWarnings.size) { summary.warnings.push(...sourceWarnings); summary.confidence = "uncertain"; }
        return summary;
      }).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      this.version++;
    }
    this.result = {
      dataVersion: this.version, scannedFiles: discovered.files.length, parseErrors,
      inaccessibleDirectories: discovered.errors.filter((message) => message.includes("directory")).length,
      inaccessibleFiles, sessions: this.cachedSessions, warnings, scannedAt: scannedAt.toISOString(),
    };
    return this.result;
  }
}

const scanner = new BrowserSessionScanner();
let restorePromise: Promise<void> | undefined;
let savedHandleNeedsPermission = false;
let refreshMs = Number(localStorage.getItem("codex-insight-refresh-ms")) || defaultRefreshMs;
if (!allowedRefreshMs.has(refreshMs)) refreshMs = defaultRefreshMs;

function openHandleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("codex-insight-local", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sources");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法保存浏览器文件夹授权"));
  });
}
async function storeHandle(handle: DirectoryHandle): Promise<void> {
  try {
    const database = await openHandleDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction("sources", "readwrite").objectStore("sources").put(handle, "sessions-directory");
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
    database.close();
  } catch { /* The selected handle remains available for this tab if storage is unavailable. */ }
}
async function readStoredHandle(): Promise<DirectoryHandle | undefined> {
  try {
    const database = await openHandleDatabase();
    const handle = await new Promise<DirectoryHandle | undefined>((resolve, reject) => {
      const request = database.transaction("sources", "readonly").objectStore("sources").get("sessions-directory");
      request.onsuccess = () => resolve(request.result as DirectoryHandle | undefined); request.onerror = () => reject(request.error);
    });
    database.close();
    return handle;
  } catch { return undefined; }
}
async function restoreStoredHandle(): Promise<void> {
  if (!restorePromise) restorePromise = (async () => {
    const handle = await readStoredHandle();
    if (!handle) return;
    try {
      if (await handle.queryPermission({ mode: "read" }) === "granted") scanner.setDirectory(handle);
      else savedHandleNeedsPermission = true;
    } catch { savedHandleNeedsPermission = true; }
  })();
  await restorePromise;
}

export function supportsDirectoryPicker(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}
export async function chooseBrowserDirectory(): Promise<string> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持直接选择文件夹，请使用 Chrome 或 Edge。");
  const handle = await picker.call(window, { id: "codex-insight-sessions", mode: "read" });
  scanner.setDirectory(handle); savedHandleNeedsPermission = false; restorePromise = Promise.resolve();
  await storeHandle(handle);
  return handle.name;
}
export function chooseBrowserFiles(files: File[]): void { scanner.setFiles(files); savedHandleNeedsPermission = false; restorePromise = Promise.resolve(); }

function settingsData() {
  const mode = scanner.sourceMode;
  return { refreshMs: mode === "snapshot" ? 0 : refreshMs, sourceMode: mode ?? "browser", ...(scanner.sourceName ? { sourceDirectory: scanner.sourceName } : {}) };
}
function parseQuery(url: URL): RangeQuery {
  return { range: url.searchParams.get("range") ?? undefined, since: url.searchParams.get("since") ?? undefined, until: url.searchParams.get("until") ?? undefined };
}

export async function browserApi<T>(input: string, init?: RequestInit): Promise<T> {
  await restoreStoredHandle();
  const url = new URL(input, window.location.origin);
  const method = init?.method?.toUpperCase() ?? "GET";
  const scan = async () => scanner.scan();

  if (url.pathname === "/api/settings" && method === "GET") return settingsData() as T;
  if (url.pathname === "/api/settings" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { refreshMs?: number; sourceDirectory?: string; useAutomatic?: boolean };
    if (body.refreshMs !== undefined) {
      if (!allowedRefreshMs.has(Number(body.refreshMs))) throw new Error("刷新间隔必须为 2、3、5 或 10 秒。");
      refreshMs = Number(body.refreshMs); localStorage.setItem("codex-insight-refresh-ms", String(refreshMs));
    }
    if (body.sourceDirectory || body.useAutomatic) throw new Error("浏览器本地模式请使用“选择文件夹”按钮授权数据目录。");
    return settingsData() as T;
  }
  if (url.pathname === "/api/refresh" && method === "POST") {
    const result = await scan();
    return { scannedAt: result.scannedAt, scannedFiles: result.scannedFiles, sessionCount: result.sessions.length, parseErrors: result.parseErrors, inaccessibleDirectories: result.inaccessibleDirectories, inaccessibleFiles: result.inaccessibleFiles } as T;
  }
  if (url.pathname === "/api/health") {
    const result = await scan();
    const sourceAvailable = scanner.sourceMode !== undefined && result.inaccessibleDirectories === 0 && result.inaccessibleFiles === 0;
    return {
      dataVersion: `browser:${result.dataVersion}`, status: !sourceAvailable || result.inaccessibleDirectories || result.inaccessibleFiles || result.parseErrors ? "warning" : "ok",
      scannedAt: result.scannedAt, sessionCount: result.sessions.length, scannedFiles: result.scannedFiles, parseErrors: result.parseErrors,
      inaccessibleDirectories: result.inaccessibleDirectories, inaccessibleFiles: result.inaccessibleFiles,
      sourceAvailable,
      refreshMs: scanner.sourceMode === "snapshot" ? 0 : refreshMs,
    } as T;
  }

  const current = scanner.current;
  const query = parseQuery(url);
  if (url.pathname === "/api/summary") {
    return { ...summarizeRange(current, query), sessionCount: current.sessions.length, scannedFiles: current.scannedFiles, parseErrors: current.parseErrors, scannedAt: current.scannedAt } as T;
  }
  if (url.pathname === "/api/projects") return { items: summarizeRange(current, { range: "all" }).projects } as T;
  if (url.pathname === "/api/models") return { items: summarizeRange(current, { range: "all" }).models } as T;
  if (url.pathname === "/api/analysis") {
    const sessionId = url.searchParams.get("sessionId") || undefined;
    const projectId = url.searchParams.get("projectId") || undefined;
    const selected = sessionId ? current.sessions.find((session) => session.id === sessionId) : undefined;
    if (sessionId && !selected) throw new Error("没有找到此会话。");
    const selectedProjectSessions = projectId ? current.sessions.filter((session) => projectKey(session.projectPath) === projectId) : current.sessions;
    if (projectId && !selectedProjectSessions.length) throw new Error("没有找到此项目。");
    if (selected && projectId && projectKey(selected.projectPath) !== projectId) throw new Error("所选会话不属于当前项目。");
    const filtered: ScanResult = { ...current, sessions: sessionId ? current.sessions.filter((session) => session.id === sessionId) : projectId ? selectedProjectSessions : current.sessions };
    const summary = summarizeRange(filtered, query);
    const sessions = current.sessions.map((session) => ({ id: session.id, title: session.title, projectKey: projectKey(session.projectPath), projectName: projectName(session.projectPath), updatedAt: session.updatedAt })).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { ...summary, sessions, selectedSessionId: selected?.id ?? null, sessionCount: selected ? 1 : selectedProjectSessions.length, scannedAt: current.scannedAt } as T;
  }
  if (url.pathname === "/api/sessions") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const project = url.searchParams.get("project") ?? undefined;
    const model = url.searchParams.get("model")?.toLowerCase();
    const sort = url.searchParams.get("sort") ?? "activity";
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
    const filtered = current.sessions.filter((session) => {
      if (!inDateRange(session, query) || (project && projectKey(session.projectPath) !== project) || (model && !session.modelNames.some((name) => name.toLowerCase() === model))) return false;
      return !q || session.id.toLowerCase().includes(q) || (session.title?.toLowerCase().includes(q) ?? false)
        || projectName(session.projectPath).toLowerCase().includes(q) || session.modelNames.some((name) => name.toLowerCase().includes(q));
    }).sort((a, b) => sortSession(a, b, sort));
    return { items: filtered.slice((page - 1) * limit, page * limit).map((session) => sessionDto(session)), total: filtered.length, page, limit } as T;
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(timeline))?$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]!);
    const session = current.sessions.find((item) => item.id === id);
    if (!session) throw new Error("没有找到此会话。");
    if (sessionMatch[2]) return { sessionId: id, points: session.timeline } as T;
    return { ...sessionDto(session, url.searchParams.get("revealPath") === "1"), perModel: session.perModel } as T;
  }
  if (url.pathname === "/api/export") return { format: url.searchParams.get("format") === "csv" ? "csv" : "json", summary: summarizeRange(current, query) } as T;
  throw new Error(`未知的本地数据请求：${url.pathname}`);
}
