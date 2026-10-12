import path from "node:path";
import { SessionScanner, defaultSessionsDirectory } from "./scanner.js";

const root = process.argv[2] ? path.resolve(process.argv[2]) : defaultSessionsDirectory();
const result = await new SessionScanner(root).scan();
const output = {
  source: process.argv[2] ? "custom" : "default",
  scannedFiles: result.scannedFiles,
  parseErrors: result.parseErrors,
  inaccessibleDirectories: result.inaccessibleDirectories,
  scannedAt: result.scannedAt,
  sessions: result.sessions.map(({ id, startedAt, updatedAt, projectPath, modelNames, usage, cacheHitRate, confidence, warnings }) => ({
    id, startedAt, updatedAt, projectPath: projectPath ? path.basename(projectPath) : undefined,
    modelNames, usage, cacheHitRate: cacheHitRate === null ? null : Number(cacheHitRate.toFixed(2)), confidence, warnings,
  })),
  warnings: result.warnings,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
