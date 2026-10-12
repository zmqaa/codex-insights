import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { SessionScanner } from "@codex-insight/core";
import { createApp, InsightService } from "../src/index.js";
import { summarizeRange } from "../src/analytics.js";

let root = "";
let server: Server;
let baseUrl = "";
let service: InsightService;
const fixturePath = fileURLToPath(new URL("../../../fixtures/rollout-reference-session.jsonl", import.meta.url));

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-insight-api-"));
  await writeFile(path.join(root, "rollout-api.jsonl"), await readFile(fixturePath));
  service = new InsightService(new SessionScanner(root));
  await service.refreshNow();
  server = createServer(createApp(service));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  service?.stop();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

test("health and summary expose local scan status and exact aggregate statistics", async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((res) => res.json()) as any;
  assert.equal(health.sessionCount, 1);
  assert.equal(health.scannedFiles, 1);
  const summary = await fetch(`${baseUrl}/api/summary?range=all`).then((res) => res.json()) as any;
  assert.equal(summary.usage.totalTokens, 2_279_416);
  assert.equal(summary.usage.uncachedInputTokens, 95_168);
  assert.equal(summary.projects[0].name, "sample-app");
  assert.equal(JSON.stringify(summary).includes("C:/projects"), false);
});

test("session list and details hide source paths unless the detail path is explicitly requested", async () => {
  const listing = await fetch(`${baseUrl}/api/sessions`).then((res) => res.json()) as any;
  assert.equal(listing.total, 1);
  assert.equal("logPaths" in listing.items[0], false);
  const id = encodeURIComponent(listing.items[0].id);
  const detail = await fetch(`${baseUrl}/api/sessions/${id}`).then((res) => res.json()) as any;
  assert.equal(detail.usage.totalTokens, 2_279_416);
  assert.equal("logPaths" in detail, false);
  const revealed = await fetch(`${baseUrl}/api/sessions/${id}?revealPath=1`).then((res) => res.json()) as any;
  assert.equal(revealed.logPaths.length, 1);
  const timeline = await fetch(`${baseUrl}/api/sessions/${id}/timeline`).then((res) => res.json()) as any;
  assert.equal(timeline.points.length, 1);
  assert.equal(JSON.stringify(timeline).includes("last_token_usage"), false);
  const refreshed = await fetch(`${baseUrl}/api/refresh`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: "{}" }).then((res) => res.text());
  assert.equal(refreshed.includes("C:/projects"), false);
  assert.equal(refreshed.includes("logPaths"), false);
});

test("cross-origin requests are rejected and local settings can be changed", async () => {
  const blocked = await fetch(`${baseUrl}/api/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(blocked.status, 403);
  const changed = await fetch(`${baseUrl}/api/settings`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ refreshMs: 5_000 }),
  });
  assert.equal(changed.status, 200);
  assert.equal(service.interval, 5_000);
  const invalid = await fetch(`${baseUrl}/api/settings`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ refreshMs: 4_000 }),
  });
  assert.equal(invalid.status, 400);
});

test("statistics exports contain numbers and metadata but never log content", async () => {
  const json = await fetch(`${baseUrl}/api/export?format=json`).then((res) => res.text());
  assert.match(json, /2279416/);
  assert.doesNotMatch(json, /last_token_usage|C:\/projects/);
  const csv = await fetch(`${baseUrl}/api/export?format=csv`).then((res) => res.text());
  assert.match(csv, /scope,dimension,date,name,total_tokens/);
  assert.match(csv, /"summary","range"/);
});

test("range aggregation attributes cross-midnight snapshot deltas by their UTC snapshot day", () => {
  const session = service.result.sessions[0]!;
  const synthetic = {
    ...service.result,
    sessions: [{
      ...session,
      usage: { totalTokens: 40, inputTokens: 30, cachedInputTokens: 10, uncachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 2 },
      timeline: [
        { timestamp: "2026-01-01T23:59:00Z", usage: { ...session.usage }, delta: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, uncachedInputTokens: 6, outputTokens: 2, reasoningOutputTokens: 1 }, kind: "snapshot" as const, warnings: [] },
        { timestamp: "2026-01-02T00:01:00Z", usage: { ...session.usage }, delta: { totalTokens: 28, inputTokens: 20, cachedInputTokens: 6, uncachedInputTokens: 14, outputTokens: 8, reasoningOutputTokens: 1 }, kind: "snapshot" as const, warnings: [] },
      ],
    }],
  };
  const dayOne = summarizeRange(synthetic, { range: "custom", since: "2026-01-01T00:00:00Z", until: "2026-01-01T23:59:59Z" }, new Date("2026-01-03T00:00:00Z"));
  assert.equal(dayOne.usage.totalTokens, 12);
  assert.equal(dayOne.daily[0]?.date, "2026-01-01");
});

test("untimestamped usage remains in all-time totals and is flagged for date ranges", () => {
  const session = service.result.sessions[0]!;
  const synthetic = {
    ...service.result,
    sessions: [{ ...session, timeline: session.timeline.map((point) => ({ ...point, timestamp: undefined })) }],
  };
  const all = summarizeRange(synthetic, { range: "all" });
  assert.equal(all.usage.totalTokens, session.usage.totalTokens);
  assert.ok(all.warnings.some((warning) => warning.includes("cannot be placed on the daily chart")));
  const custom = summarizeRange(synthetic, { range: "custom", since: "2026-01-01T00:00:00Z" });
  assert.equal(custom.usage.totalTokens, 0);
  assert.ok(custom.warnings.some((warning) => warning.includes("excluded from date-filtered totals")));
});
