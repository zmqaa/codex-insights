import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionScanner, defaultSessionsDirectory, emptyScanResult, type ScanResult, type SessionSummary } from "@codex-insight/core";
import { inDateRange, projectKey, projectName, safeSortUsage, sessionDto, summarizeRange, type RangeQuery } from "./analytics.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const productionWebDirectory = path.resolve(serverDirectory, "../../web/dist");
const DEFAULT_REFRESH_MS = 3_000;
const ALLOWED_REFRESH_MS = new Set([2_000, 3_000, 5_000, 10_000]);
const automaticRoot = () => path.resolve(process.env.CODEX_INSIGHT_SESSIONS ?? defaultSessionsDirectory());

function localHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value === "127.0.0.1" || value.startsWith("127.");
}

function isLoopbackRequest(request: Request): boolean {
  const host = request.get("host");
  if (!host) return false;
  try {
    if (!localHostname(new URL(`http://${host}`).hostname)) return false;
  } catch { return false; }
  const origin = request.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && localHostname(parsed.hostname);
  } catch { return false; }
}

export class InsightService {
  private current: ScanResult = emptyScanResult();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<ScanResult>;
  private readonly instanceId = randomUUID();
  private readonly summaries = new WeakMap<ScanResult, Map<string, ReturnType<typeof summarizeRange>>>();
  constructor(public readonly scanner: SessionScanner, private refreshMs = DEFAULT_REFRESH_MS) {}

  get result(): ScanResult { return this.current; }
  get interval(): number { return this.refreshMs; }
  get dataVersion(): string { return `${this.instanceId}:${this.current.dataVersion}`; }

  summarize(query: RangeQuery = {}, sessionId?: string, projectId?: string): ReturnType<typeof summarizeRange> {
    const source = this.current;
    let cache = this.summaries.get(source);
    if (!cache) { cache = new Map(); this.summaries.set(source, cache); }
    const key = JSON.stringify([query.range ?? null, query.since ?? null, query.until ?? null, sessionId ?? null, projectId ?? null]);
    const existing = cache.get(key);
    if (existing) return existing;
    const scan = sessionId === undefined && projectId === undefined
      ? source
      : { ...source, sessions: source.sessions.filter((session) =>
        (sessionId === undefined || session.id === sessionId)
        && (projectId === undefined || projectKey(session.projectPath) === projectId)) };
    const scannedAt = Date.parse(source.scannedAt);
    const summary = summarizeRange(scan, query, Number.isFinite(scannedAt) ? new Date(scannedAt) : new Date());
    cache.set(key, summary);
    return summary;
  }

  async refreshNow(): Promise<ScanResult> {
    if (!this.pending) {
      this.pending = this.scanner.scan().then((result) => {
        this.current = result;
        return result;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => { void this.refreshNow(); }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setIntervalMs(value: number): void {
    if (!ALLOWED_REFRESH_MS.has(value)) throw new Error("Refresh interval must be 2, 3, 5, or 10 seconds");
    this.refreshMs = value;
    this.start();
  }
}

export function createApp(service: InsightService, staticDirectory?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
    if (!isLoopbackRequest(request)) return response.status(403).json({ error: "Local loopback access is required" });
    next();
  });
  app.use(express.json({ limit: "8kb" }));

  app.get("/api/health", (_request, response) => {
    const result = service.result;
    response.json({
      dataVersion: service.dataVersion,
      status: result.inaccessibleDirectories > 0 || result.inaccessibleFiles > 0 || result.parseErrors > 0 ? "warning" : "ok",
      scannedAt: result.scannedAt,
      sessionCount: result.sessions.length,
      scannedFiles: result.scannedFiles,
      parseErrors: result.parseErrors,
      inaccessibleDirectories: result.inaccessibleDirectories,
      inaccessibleFiles: result.inaccessibleFiles,
      sourceAvailable: result.inaccessibleDirectories === 0 && result.inaccessibleFiles === 0,
      refreshMs: service.interval,
    });
  });

  app.get("/api/summary", (request, response) => {
    const summary = service.summarize({
      range: typeof request.query.range === "string" ? request.query.range : undefined,
      since: typeof request.query.since === "string" ? request.query.since : undefined,
      until: typeof request.query.until === "string" ? request.query.until : undefined,
    });
    response.json({ ...summary, sessionCount: service.result.sessions.length, scannedFiles: service.result.scannedFiles, parseErrors: service.result.parseErrors, scannedAt: service.result.scannedAt });
  });

  app.get("/api/analysis", (request, response) => {
    const selectedSessionId = typeof request.query.sessionId === "string" && request.query.sessionId.length > 0
      ? request.query.sessionId
      : undefined;
    const selectedSession = selectedSessionId
      ? service.result.sessions.find((session) => session.id === selectedSessionId)
      : undefined;
    if (selectedSessionId && !selectedSession) return response.status(404).json({ error: "Session not found" });
    const selectedProjectId = typeof request.query.projectId === "string" && request.query.projectId.length > 0
      ? request.query.projectId
      : undefined;
    const projectSessions = selectedProjectId
      ? service.result.sessions.filter((session) => projectKey(session.projectPath) === selectedProjectId)
      : service.result.sessions;
    if (selectedProjectId && projectSessions.length === 0) return response.status(404).json({ error: "Project not found" });
    if (selectedSession && selectedProjectId && projectKey(selectedSession.projectPath) !== selectedProjectId) {
      return response.status(400).json({ error: "Selected session does not belong to the selected project" });
    }

    const summary = service.summarize({
      range: typeof request.query.range === "string" ? request.query.range : undefined,
      since: typeof request.query.since === "string" ? request.query.since : undefined,
      until: typeof request.query.until === "string" ? request.query.until : undefined,
    }, selectedSession?.id, selectedProjectId);
    const sessions = service.result.sessions
      .map((session) => ({ id: session.id, title: session.title, projectKey: projectKey(session.projectPath), projectName: projectName(session.projectPath), updatedAt: session.updatedAt }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    response.json({
      ...summary,
      sessions,
      selectedSessionId: selectedSession?.id ?? null,
      sessionCount: selectedSession ? 1 : projectSessions.length,
      scannedAt: service.result.scannedAt,
    });
  });

  app.get("/api/sessions", (request, response) => {
    const q = typeof request.query.q === "string" ? request.query.q.trim().toLowerCase() : "";
    const selectedProject = typeof request.query.project === "string" ? request.query.project : undefined;
    const selectedModel = typeof request.query.model === "string" ? request.query.model.toLowerCase() : undefined;
    const sort = typeof request.query.sort === "string" ? request.query.sort : "activity";
    const rangeQuery = {
      range: typeof request.query.range === "string" ? request.query.range : undefined,
      since: typeof request.query.since === "string" ? request.query.since : undefined,
      until: typeof request.query.until === "string" ? request.query.until : undefined,
    };
    const page = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "50"), 10) || 50));
    const filtered = service.result.sessions.filter((session) => {
      if (!inDateRange(session, rangeQuery)) return false;
      if (selectedProject && projectKey(session.projectPath) !== selectedProject) return false;
      if (selectedModel && !session.modelNames.some((model) => model.toLowerCase() === selectedModel)) return false;
      if (!q) return true;
      return session.id.toLowerCase().includes(q)
        || (session.title?.toLowerCase().includes(q) ?? false)
        || projectName(session.projectPath).toLowerCase().includes(q)
        || session.modelNames.some((model) => model.toLowerCase().includes(q));
    }).sort((a, b) => safeSortUsage(a, b, sort));
    const start = (page - 1) * limit;
    response.json({ items: filtered.slice(start, start + limit).map((session) => sessionDto(session)), total: filtered.length, page, limit });
  });

  app.get("/api/sessions/:id/timeline", (request, response) => {
    const session = service.result.sessions.find((item) => item.id === request.params.id);
    if (!session) return response.status(404).json({ error: "Session not found" });
    response.json({ sessionId: session.id, points: session.timeline });
  });

  app.get("/api/sessions/:id", (request, response) => {
    const session = service.result.sessions.find((item) => item.id === request.params.id);
    if (!session) return response.status(404).json({ error: "Session not found" });
    const revealPath = request.query.revealPath === "1";
    response.json({ ...sessionDto(session, revealPath), perModel: session.perModel, confidence: session.confidence });
  });

  app.get("/api/projects", (_request, response) => {
    const projects = service.summarize({ range: "all" }).projects;
    response.json({ items: projects });
  });

  app.get("/api/models", (_request, response) => {
    const models = service.summarize({ range: "all" }).models;
    response.json({ items: models });
  });

  app.get("/api/settings", (request, response) => {
    response.json({
      refreshMs: service.interval,
      sourceMode: service.scanner.getRoot() === automaticRoot() ? "automatic" : "custom",
      ...(request.query.revealPath === "1" ? { sourceDirectory: service.scanner.getRoot() } : {}),
    });
  });

  app.post("/api/settings", async (request, response, next) => {
    try {
      const body = request.body as { sourceDirectory?: unknown; refreshMs?: unknown; useAutomatic?: unknown };
      if (body.refreshMs !== undefined) {
        const refreshMs = Number(body.refreshMs);
        if (!ALLOWED_REFRESH_MS.has(refreshMs)) return response.status(400).json({ error: "Refresh interval must be 2, 3, 5, or 10 seconds" });
      }
      let nextRoot: string | undefined;
      if (body.useAutomatic === true) nextRoot = automaticRoot();
      else if (body.sourceDirectory !== undefined) {
        if (typeof body.sourceDirectory !== "string" || !path.isAbsolute(body.sourceDirectory.trim())) {
          return response.status(400).json({ error: "Session directory must be an absolute path" });
        }
        nextRoot = path.resolve(body.sourceDirectory.trim());
        let stat;
        try { stat = await fs.stat(nextRoot); }
        catch { return response.status(400).json({ error: "Session directory does not exist or cannot be read" }); }
        if (!stat.isDirectory()) return response.status(400).json({ error: "Session path must point to a directory" });
      }
      if (nextRoot) service.scanner.setRoot(nextRoot);
      if (body.refreshMs !== undefined) service.setIntervalMs(Number(body.refreshMs));
      await service.refreshNow();
      response.json({ ok: true, refreshMs: service.interval, sourceMode: service.scanner.getRoot() === automaticRoot() ? "automatic" : "custom" });
    } catch (error) { next(error); }
  });

  app.post("/api/refresh", async (_request, response, next) => {
    try {
      const result = await service.refreshNow();
      response.json({ scannedAt: result.scannedAt, scannedFiles: result.scannedFiles, sessionCount: result.sessions.length, parseErrors: result.parseErrors, inaccessibleDirectories: result.inaccessibleDirectories, inaccessibleFiles: result.inaccessibleFiles });
    } catch (error) { next(error); }
  });

  app.get("/api/export", (request, response) => {
    const format = request.query.format === "csv" ? "csv" : "json";
    const summary = service.summarize({
      range: typeof request.query.range === "string" ? request.query.range : "all",
      since: typeof request.query.since === "string" ? request.query.since : undefined,
      until: typeof request.query.until === "string" ? request.query.until : undefined,
    });
    const data = { range: summary.range, since: summary.since, until: summary.until, usage: summary.usage, cacheHitRate: summary.cacheHitRate, apiCost: summary.apiCost, daily: summary.daily, projects: summary.projects, models: summary.models, warnings: summary.warnings };
    if (format === "json") return response.attachment("codex-insight-statistics.json").type("application/json").send(JSON.stringify(data, null, 2));
    const safe = (value: string | number) => {
      const text = String(value);
      return `"${( /^[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    const lines = ["scope,dimension,date,name,total_tokens,input_tokens,cached_input_tokens,uncached_input_tokens,output_tokens,reasoning_output_tokens,cache_hit_rate,uncached_input_rate,estimated_api_cost_usd,api_pricing_status,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million,session_count"];
    const usageCells = (usage: typeof summary.usage) => [usage.totalTokens, usage.inputTokens, usage.cachedInputTokens, usage.uncachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens];
    const cacheRate = (usage: typeof summary.usage) => usage.inputTokens === 0 ? "N/A" : (usage.cachedInputTokens / usage.inputTokens * 100).toFixed(2);
    const uncachedRate = (usage: typeof summary.usage) => usage.inputTokens === 0 ? "N/A" : (usage.uncachedInputTokens / usage.inputTokens * 100).toFixed(2);
    lines.push(["summary", "range", summary.since ?? "", summary.range, ...usageCells(summary.usage), cacheRate(summary.usage), uncachedRate(summary.usage), summary.apiCost.estimatedUsd, summary.apiCost.status, "", "", "", ""].map(safe).join(","));
    for (const day of summary.daily) lines.push(["daily", "UTC day", day.date, "", ...usageCells(day), cacheRate(day), uncachedRate(day), "", "", "", "", "", ""].map(safe).join(","));
    for (const project of summary.projects) lines.push(["project", "project", "", project.name, ...usageCells(project), "", "", "", "", "", "", "", project.sessionCount].map(safe).join(","));
    for (const model of summary.models) lines.push([
      "model", "model", "", model.name, ...usageCells(model),
      model.cacheHitRate === null ? "N/A" : model.cacheHitRate.toFixed(2),
      model.uncachedInputRate === null ? "N/A" : model.uncachedInputRate.toFixed(2),
      model.estimatedApiCostUsd ?? "N/A", model.estimatedApiCostUsd === null ? "unpriced" : "priced",
      model.apiPricePerMillionUsd?.input ?? "", model.apiPricePerMillionUsd?.cachedInput ?? "", model.apiPricePerMillionUsd?.output ?? "", model.sessionCount,
    ].map(safe).join(","));
    return response.attachment("codex-insight-statistics.csv").type("text/csv; charset=utf-8").send(`\uFEFF${lines.join("\r\n")}`);
  });

  if (staticDirectory) {
    app.use(express.static(staticDirectory, { index: false, fallthrough: true, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_request, response) => response.sendFile(path.join(staticDirectory, "index.html")));
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    response.status(500).json({ error: message });
  });
  return app;
}

async function listenLoopback(app: express.Express, preferredPort: number): Promise<{ server: Server; port: number }> {
  let lastError: unknown;
  for (let port = preferredPort; port <= preferredPort + 20; port++) {
    const server = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      return { server, port };
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw lastError ?? new Error("No available loopback port");
}

export async function startServer(options: { port?: number; root?: string; staticDirectory?: string } = {}) {
  const root = options.root ?? process.env.CODEX_INSIGHT_SESSIONS ?? defaultSessionsDirectory();
  const service = new InsightService(new SessionScanner(root));
  await service.refreshNow();
  service.start();
  let staticDirectory = options.staticDirectory;
  if (staticDirectory === undefined) {
    try { await fs.access(productionWebDirectory); staticDirectory = productionWebDirectory; }
    catch { staticDirectory = undefined; }
  }
  const { server, port } = await listenLoopback(createApp(service, staticDirectory), options.port ?? Number(process.env.PORT ?? 4173));
  process.stdout.write(`Codex Insight is ready at http://127.0.0.1:${port}\n`);
  process.stdout.write(`Scanning ${service.result.scannedFiles} session log file(s); ${service.result.parseErrors} malformed line(s).\n`);
  const stop = () => { service.stop(); server.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { service, server, port, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await startServer();
