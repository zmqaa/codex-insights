import { promises as fs, type FileHandle } from "node:fs";
import path from "node:path";
import os from "node:os";
import { aggregateSession, type TimedEvent } from "./aggregate.js";
import { parseJsonlLine, type LogEvent } from "./parser.js";
import type { ScanResult, SessionSummary } from "./types.js";

type FileState = {
  identity: string;
  observedSize: number;
  readOffset: number;
  mtimeMs: number;
  tail: Buffer;
  anchor: Buffer;
  events: Array<{ event: LogEvent; line: number }>;
  parseErrors: number;
  lineNumber: number;
  warnings: string[];
};

type SessionNameIndex = { path: string; size: number; mtimeMs: number; names: Map<string, string> };
type ScanDiagnostics = { inaccessibleDirectories: number; inaccessibleFiles: number; warnings: string[] };

function sameMap(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function sameDiagnostics(left: ScanDiagnostics | undefined, right: ScanDiagnostics): boolean {
  return !!left
    && left.inaccessibleDirectories === right.inaccessibleDirectories
    && left.inaccessibleFiles === right.inaccessibleFiles
    && left.warnings.length === right.warnings.length
    && left.warnings.every((warning, index) => warning === right.warnings[index]);
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function defaultSessionsDirectory(): string {
  return path.join(defaultCodexHome(), "sessions");
}

function sessionIdFromFile(filePath: string): string {
  const basename = path.basename(filePath, ".jsonl");
  const match = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? basename;
}

async function discoverFiles(root: string): Promise<{ files: string[]; inaccessible: number; warnings: string[] }> {
  const files: string[] = [];
  const warnings: string[] = [];
  let inaccessible = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      inaccessible++;
      warnings.push(`Cannot read a session directory (${error instanceof Error ? error.message : "unknown error"})`);
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(fullPath);
    }
  };
  await visit(root);
  return { files, inaccessible, warnings };
}

async function readAnchor(handle: FileHandle, end: number): Promise<Buffer> {
  const length = Math.min(256, Math.max(0, end));
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, end - length);
  return buffer.subarray(0, bytesRead);
}

function sameBuffer(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

export class SessionScanner {
  private root: string;
  private readonly fileStates = new Map<string, FileState>();
  private sessionNameIndex?: SessionNameIndex;
  private scanSequence = 0;
  private dataVersion = 0;
  private dataDirty = true;
  private cachedSummaries: SessionSummary[] = [];
  private cachedSessionNames = new Map<string, string>();
  private previousDiagnostics?: ScanDiagnostics;

  constructor(root = defaultSessionsDirectory(), private readonly activeWindowMs = 15_000) {
    this.root = path.resolve(root);
  }

  getRoot(): string { return this.root; }

  setRoot(root: string): void {
    this.root = path.resolve(root);
    this.fileStates.clear();
    this.sessionNameIndex = undefined;
    this.cachedSummaries = [];
    this.cachedSessionNames.clear();
    this.previousDiagnostics = undefined;
    this.dataDirty = true;
  }

  private async readSessionNames(): Promise<Map<string, string>> {
    const candidates = [
      path.join(path.dirname(this.root), "session_index.jsonl"),
      path.join(this.root, "session_index.jsonl"),
    ];
    for (const indexPath of candidates) {
      try {
        const stat = await fs.stat(indexPath);
        const cachedIndex = this.sessionNameIndex;
        if (cachedIndex && cachedIndex.path === indexPath
          && cachedIndex.size === stat.size
          && cachedIndex.mtimeMs === stat.mtimeMs) return cachedIndex.names;

        const names = new Map<string, string>();
        const contents = await fs.readFile(indexPath, "utf8");
        for (const line of contents.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
            if (typeof entry.id !== "string" || typeof entry.thread_name !== "string") continue;
            const title = entry.thread_name.trim();
            if (title) names.set(entry.id, title);
          } catch {
            // Ignore malformed metadata rows; token usage scanning is independent of this index.
          }
        }
        this.sessionNameIndex = { path: indexPath, size: stat.size, mtimeMs: stat.mtimeMs, names };
        return names;
      } catch {
        // A Codex title index is optional, especially for custom session directories.
      }
    }
    this.sessionNameIndex = undefined;
    return new Map();
  }

  async scan(): Promise<ScanResult> {
    this.scanSequence++;
    const scannedAt = new Date();
    let dataChanged = this.dataDirty;
    this.dataDirty = false;
    let realRoot: string;
    try { realRoot = await fs.realpath(this.root); }
    catch (error) {
      const warnings = [`Session directory is unavailable (${error instanceof Error ? error.message : "unknown error"})`];
      const diagnostics: ScanDiagnostics = { inaccessibleDirectories: 1, inaccessibleFiles: 0, warnings };
      dataChanged ||= this.fileStates.size > 0 || this.cachedSummaries.length > 0 || !sameDiagnostics(this.previousDiagnostics, diagnostics);
      this.fileStates.clear();
      this.sessionNameIndex = undefined;
      this.cachedSessionNames.clear();
      this.cachedSummaries = [];
      this.previousDiagnostics = diagnostics;
      if (dataChanged) this.dataVersion++;
      return {
        dataVersion: this.dataVersion, scannedFiles: 0, parseErrors: 0, inaccessibleDirectories: 1, inaccessibleFiles: 0, sessions: [], warnings,
        scannedAt: scannedAt.toISOString(),
      };
    }
    const discovered = await discoverFiles(realRoot);
    const currentPaths = new Set(discovered.files.map((file) => path.resolve(file)));
    for (const existing of this.fileStates.keys()) {
      if (!currentPaths.has(existing)) { this.fileStates.delete(existing); dataChanged = true; }
    }
    let pathsRead = 0;
    let inaccessibleFiles = 0;
    for (const fullPath of discovered.files) {
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        const existing = this.fileStates.get(path.resolve(fullPath));
        const identity = `${stat.dev}:${stat.ino}`;
        let state = existing;
        if (!state) {
          state = { identity, observedSize: 0, readOffset: 0, mtimeMs: 0, tail: Buffer.alloc(0), anchor: Buffer.alloc(0), events: [], parseErrors: 0, lineNumber: 0, warnings: [] };
          this.fileStates.set(path.resolve(fullPath), state);
          dataChanged = true;
        }
        const handle = await fs.open(fullPath, "r");
        try {
          const consumedEnd = state.readOffset - state.tail.length;
          const currentAnchor = await readAnchor(handle, consumedEnd);
          const replaced = state.identity !== identity;
          const truncated = stat.size < state.readOffset;
          const sameSizeRewrite = state.observedSize === stat.size && state.mtimeMs !== 0 && state.mtimeMs !== stat.mtimeMs;
          const overwritten = state.anchor.length > 0 && !sameBuffer(state.anchor, currentAnchor);
          if (replaced || truncated || sameSizeRewrite || overwritten) {
            dataChanged = true;
            state.warnings.push("Log file was truncated or replaced; earlier snapshots from that file were discarded");
            state.identity = identity;
            state.observedSize = 0;
            state.readOffset = 0;
            state.mtimeMs = 0;
            state.tail = Buffer.alloc(0);
            state.anchor = Buffer.alloc(0);
            state.events = [];
            state.parseErrors = 0;
            state.lineNumber = 0;
          }
          if (stat.size > state.readOffset) {
            let position = state.readOffset;
            let accumulated = state.tail;
            const chunk = Buffer.alloc(64 * 1024);
            let lineNumber = state.lineNumber;
            while (position < stat.size) {
              const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
              if (bytesRead === 0) break;
              const bytes = chunk.subarray(0, bytesRead);
              position += bytesRead;
              accumulated = Buffer.concat([accumulated, bytes]);
              let newline: number;
              while ((newline = accumulated.indexOf(0x0a)) !== -1) {
                let line = accumulated.subarray(0, newline);
                accumulated = accumulated.subarray(newline + 1);
                if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
                lineNumber++;
                state.lineNumber = lineNumber;
                const decoded = line.toString("utf8").trim();
                if (!decoded) continue;
                const result = parseJsonlLine(decoded);
                if (result.error) state.parseErrors++;
                else if (result.event) { state.events.push({ event: result.event, line: lineNumber }); dataChanged = true; }
              }
            }
            state.readOffset = position;
            state.tail = accumulated;
            const completeEnd = state.readOffset - state.tail.length;
            state.anchor = await readAnchor(handle, completeEnd);
          }
          state.observedSize = stat.size;
          state.mtimeMs = stat.mtimeMs;
          pathsRead++;
        } finally { await handle.close(); }
      } catch {
        // File errors are isolated; scanning other sessions should continue.
        inaccessibleFiles++;
      }
    }

    const sessionNames = await this.readSessionNames();
    if (!sameMap(sessionNames, this.cachedSessionNames)) dataChanged = true;
    this.cachedSessionNames = new Map(sessionNames);
    const parseErrors = [...this.fileStates.values()].reduce((total, state) => total + state.parseErrors, 0);
    const warnings = [...discovered.warnings];
    if (parseErrors) warnings.push(`${parseErrors} malformed JSONL line(s) skipped`);
    if (inaccessibleFiles) warnings.push(`${inaccessibleFiles} matching session log file(s) could not be read`);
    const diagnostics: ScanDiagnostics = { inaccessibleDirectories: discovered.inaccessible, inaccessibleFiles, warnings };
    if (!sameDiagnostics(this.previousDiagnostics, diagnostics)) dataChanged = true;
    this.previousDiagnostics = diagnostics;

    let summaries: SessionSummary[];
    if (dataChanged) {
      const sessions = new Map<string, TimedEvent[]>();
      let eventOrder = 0;
      for (const [file, state] of this.fileStates) {
        const fallbackId = sessionIdFromFile(file);
        let sessionId = fallbackId;
        for (const row of state.events) {
          if (row.event.kind === "meta" && row.event.sessionId) { sessionId = row.event.sessionId; break; }
        }
        const rows = sessions.get(sessionId) ?? [];
        for (const row of state.events) rows.push({ ...row, file, order: eventOrder++ });
        sessions.set(sessionId, rows);
      }
      summaries = [...sessions.entries()].map(([id, rows]) => {
        const recentFile = rows.some((row) => {
          const state = this.fileStates.get(row.file);
          return state && scannedAt.getTime() - state.mtimeMs <= this.activeWindowMs;
        });
        const summary = aggregateSession(id, rows, recentFile);
        const title = sessionNames.get(id);
        if (title) summary.title = title;
        summary.logPaths = [...new Set(rows.map((row) => row.file))].sort();
        const sourceWarnings = new Set(rows.flatMap((row) => this.fileStates.get(row.file)?.warnings ?? []));
        const hasStableId = rows.some((row) => row.event.kind === "meta" && !!row.event.sessionId);
        if (!hasStableId) sourceWarnings.add("Session metadata ID is missing; this session is grouped by its log filename");
        const malformedLines = new Set(rows.filter((row) => this.fileStates.get(row.file)?.parseErrors).map((row) => row.file));
        if (malformedLines.size) sourceWarnings.add(`${malformedLines.size} session log file(s) contained malformed JSONL lines`);
        if (sourceWarnings.size) {
          summary.warnings.push(...sourceWarnings);
          summary.confidence = "uncertain";
        }
        return summary;
      }).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      this.cachedSummaries = summaries;
      this.dataVersion++;
    } else {
      let activityChanged = false;
      summaries = this.cachedSummaries.map((summary) => {
        const isUpdating = (summary.logPaths ?? []).some((file) => {
          const state = this.fileStates.get(path.resolve(file));
          return state !== undefined && scannedAt.getTime() - state.mtimeMs <= this.activeWindowMs;
        });
        if (isUpdating === summary.isUpdating) return summary;
        activityChanged = true;
        return { ...summary, isUpdating };
      });
      if (activityChanged) this.dataVersion++;
      this.cachedSummaries = summaries;
    }
    return {
      dataVersion: this.dataVersion,
      scannedFiles: pathsRead, parseErrors, inaccessibleDirectories: discovered.inaccessible, inaccessibleFiles,
      sessions: summaries, warnings, scannedAt: scannedAt.toISOString(),
    };
  }
}
