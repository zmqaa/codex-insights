import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateSession, cacheHitRate, parseJsonlLine, SessionScanner, ZERO_USAGE } from "../src/index.js";

const fixturePath = fileURLToPath(new URL("../../../fixtures/rollout-reference-session.jsonl", import.meta.url));
const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-insight-"));
  tempDirs.push(dir);
  return dir;
}
test.after(async () => { await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

function eventLine(timestamp: string, input: number, cached: number, output: number, reasoning: number, total = input + output): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total },
    last_token_usage: { input_tokens: 800, output_tokens: 40, total_tokens: 840 },
  } } });
}

test("parses cumulative snapshots and preserves reported total independently", () => {
  const parsed = parseJsonlLine(eventLine("2026-01-01T00:00:00Z", 100, 60, 20, 5, 999));
  assert.equal(parsed.event?.kind, "snapshot");
  if (parsed.event?.kind !== "snapshot") return;
  const summary = aggregateSession("s", [{ event: parsed.event, file: "a", line: 1, order: 0 }]);
  assert.equal(summary.usage.totalTokens, 999);
  assert.equal(summary.usage.inputTokens, 100);
  assert.equal(summary.usage.cachedInputTokens, 60);
  assert.equal(summary.usage.uncachedInputTokens, 40);
  assert.equal(summary.usage.outputTokens, 20);
  assert.equal(summary.usage.reasoningOutputTokens, 5);
  assert.ok(summary.warnings.some((warning) => warning.includes("differs")));
});

test("repeated cumulative snapshots and last_token_usage are never added twice", async () => {
  const root = await tempDir();
  await writeFile(path.join(root, "rollout-copy-01a12dde-3fdc-77e3-bb77-0ff66e3adfca.jsonl"), await readFile(fixturePath));
  await writeFile(path.join(root, "rollout-copy2-01a12dde-3fdc-77e3-bb77-0ff66e3adfca.jsonl"), await readFile(fixturePath));
  const result = await new SessionScanner(root).scan();
  assert.equal(result.sessions.length, 1);
  const usage = result.sessions[0]!.usage;
  assert.deepEqual(usage, { totalTokens: 2_279_416, inputTokens: 2_241_216, cachedInputTokens: 2_146_048, uncachedInputTokens: 95_168, outputTokens: 38_200, reasoningOutputTokens: 7_175 });
});

test("cache hit rate rounds to the reference percentage and is N/A for zero input", async () => {
  const root = await tempDir();
  await writeFile(path.join(root, "rollout-reference.jsonl"), await readFile(fixturePath));
  const result = await new SessionScanner(root).scan();
  assert.equal(Number(result.sessions[0]!.cacheHitRate!.toFixed(2)), 95.75);
  assert.equal(cacheHitRate({ ...ZERO_USAGE }), null);
});

test("keeps a partial final JSONL line buffered until its newline arrives", async () => {
  const root = await tempDir();
  const file = path.join(root, "rollout-incremental.jsonl");
  const prefix = `${JSON.stringify({ type: "session_meta", payload: { id: "incremental" } })}\n`;
  const snapshot = eventLine("2026-03-01T00:00:00Z", 100, 40, 20, 4);
  await writeFile(file, prefix + snapshot.slice(0, 50));
  const scanner = new SessionScanner(root);
  let result = await scanner.scan();
  assert.equal(result.sessions[0]!.usage.totalTokens, 0);
  await writeFile(file, snapshot.slice(50) + "\n", { flag: "a" });
  result = await scanner.scan();
  assert.equal(result.sessions[0]!.usage.totalTokens, 120);
  assert.equal(result.sessions[0]!.usage.inputTokens, 100);
});

test("skips malformed middle rows, reports them, and continues parsing", async () => {
  const root = await tempDir();
  const file = path.join(root, "rollout-bad.jsonl");
  await writeFile(file, `${eventLine("2026-04-01T00:00:00Z", 10, 4, 2, 1)}\n{broken json}\n${eventLine("2026-04-01T00:01:00Z", 20, 8, 4, 2)}\n`);
  const result = await new SessionScanner(root).scan();
  assert.equal(result.parseErrors, 1);
  assert.equal(result.sessions[0]!.usage.totalTokens, 24);
  assert.equal(result.sessions[0]!.confidence, "uncertain");
  assert.ok(result.sessions[0]!.warnings.some((warning) => warning.includes("malformed JSONL")));
  assert.ok(result.warnings.some((warning) => warning.includes("malformed")));
});

test("detects truncation and treats a lower cumulative snapshot as a new reset segment", async () => {
  const root = await tempDir();
  const file = path.join(root, "rollout-reset.jsonl");
  await writeFile(file, `${eventLine("2026-05-01T00:00:00Z", 100, 40, 20, 4)}\n`);
  const scanner = new SessionScanner(root);
  assert.equal((await scanner.scan()).sessions[0]!.usage.totalTokens, 120);
  await writeFile(file, `${eventLine("2026-05-02T00:00:00Z", 30, 10, 5, 1)}\n`);
  const result = await scanner.scan();
  assert.equal(result.sessions[0]!.usage.totalTokens, 35);
  assert.ok(result.sessions[0]!.warnings.some((warning) => warning.includes("truncated or replaced")));
});

test("splits deltas by the active model across model switches", () => {
  const rows = [
    { event: { kind: "model" as const, timestamp: "2026-06-01T00:00:00Z", model: "alpha" }, file: "x", line: 1, order: 0 },
    { event: { kind: "snapshot" as const, timestamp: "2026-06-01T00:01:00Z", usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1 }, warnings: [] }, file: "x", line: 2, order: 1 },
    { event: { kind: "model" as const, timestamp: "2026-06-01T00:02:00Z", model: "beta" }, file: "x", line: 3, order: 2 },
    { event: { kind: "snapshot" as const, timestamp: "2026-06-01T00:03:00Z", usage: { inputTokens: 25, cachedInputTokens: 15, outputTokens: 5, reasoningOutputTokens: 2 }, warnings: [] }, file: "x", line: 4, order: 3 },
  ];
  const result = aggregateSession("multi", rows);
  assert.deepEqual(result.modelNames, ["alpha", "beta"]);
  assert.equal(result.perModel.alpha!.totalTokens, 12);
  assert.equal(result.perModel.beta!.totalTokens, 18);
});

test("does not carry a model label from one merged log into another model-less file", () => {
  const rows = [
    { event: { kind: "model" as const, timestamp: "2026-06-02T00:00:00Z", model: "alpha" }, file: "a", line: 1, order: 0 },
    { event: { kind: "snapshot" as const, timestamp: "2026-06-02T00:01:00Z", usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1 }, warnings: [] }, file: "a", line: 2, order: 1 },
    { event: { kind: "model" as const, timestamp: "2026-06-02T00:02:00Z", model: "beta" }, file: "b", line: 1, order: 2 },
    { event: { kind: "snapshot" as const, timestamp: "2026-06-02T00:03:00Z", usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 4, reasoningOutputTokens: 2 }, warnings: [] }, file: "b", line: 2, order: 3 },
    { event: { kind: "snapshot" as const, timestamp: "2026-06-02T00:04:00Z", usage: { inputTokens: 25, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 }, warnings: [] }, file: "c", line: 1, order: 4 },
  ];
  const result = aggregateSession("merged-models", rows);
  assert.equal(result.perModel.alpha!.totalTokens, 12);
  assert.equal(result.perModel.beta!.totalTokens, 12);
  assert.equal(result.perModel["Mixed / unknown"]!.totalTokens, 6);
  assert.ok(result.warnings.some((warning) => warning.includes("cannot be reliably attributed")));
});

test("clamps uncached input to zero and records cache-over-input anomaly", () => {
  const parsed = parseJsonlLine(eventLine("2026-07-01T00:00:00Z", 10, 12, 3, 1));
  if (parsed.event?.kind !== "snapshot") assert.fail("snapshot expected");
  const result = aggregateSession("anomaly", [{ event: parsed.event, file: "x", line: 1, order: 0 }]);
  assert.equal(result.usage.uncachedInputTokens, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("exceeds input_tokens")));
});

test("stable cumulative snapshots produce zero delta, and timestamp inversion is reported", () => {
  const rows = [
    { event: parseJsonlLine(eventLine("2026-08-01T00:01:00Z", 20, 8, 4, 2)).event!, file: "x", line: 1, order: 0 },
    { event: parseJsonlLine(eventLine("2026-08-01T00:00:00Z", 10, 4, 2, 1)).event!, file: "x", line: 2, order: 1 },
    { event: parseJsonlLine(eventLine("2026-08-01T00:01:00Z", 20, 8, 4, 2)).event!, file: "x", line: 3, order: 2 },
  ];
  const result = aggregateSession("ordered", rows);
  assert.equal(result.usage.totalTokens, 24);
  assert.equal(result.timeline.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("out of order")));
});

test("handles nested directories and ignores non-rollout files and symlinks", async () => {
  const root = await tempDir();
  const nested = path.join(root, "2026", "10", "12");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "rollout-nested.jsonl"), await readFile(fixturePath));
  await writeFile(path.join(nested, "notes.jsonl"), await readFile(fixturePath));
  const result = await new SessionScanner(root).scan();
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.sessions.length, 1);
});

test("a changed file with equal size is reparsed when its modification time changes", async () => {
  const root = await tempDir();
  const file = path.join(root, "rollout-overwrite.jsonl");
  const first = `${eventLine("2026-09-01T00:00:00Z", 10, 4, 2, 1)}\n`;
  const second = `${eventLine("2026-09-02T00:00:00Z", 10, 4, 2, 1)}\n`;
  assert.equal(first.length, second.length);
  await writeFile(file, first);
  const scanner = new SessionScanner(root);
  assert.equal((await scanner.scan()).sessions[0]!.updatedAt, "2026-09-01T00:00:00Z");
  await writeFile(file, second);
  const future = new Date(Date.now() + 5_000);
  await utimes(file, future, future);
  assert.equal((await scanner.scan()).sessions[0]!.updatedAt, "2026-09-02T00:00:00Z");
});
