import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { persistEvaluationResult } from "../../src/lib/evaluation-persistence.mjs";
import { runSupervisedCommand } from "../../src/lib/process-supervisor.mjs";
import { evaluationResult } from "./evaluation-fixture.mjs";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-persist-"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "applications.md"), [
    "# Applications Tracker",
    "",
    "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "",
  ].join("\n"));
  return root;
}

function runCoreCommand(command, args, options) {
  const [script, ...rest] = args;
  return runSupervisedCommand(command, [path.join(CORE, path.basename(script)), ...rest], options);
}

test("backend persistence reserves, writes, dedupes, confirms, and releases", { timeout: 30_000 }, async () => {
  const root = makeWorkspace();
  const input = "https://example.com/jobs/ai-platform?source=career";
  try {
    const first = await persistEvaluationResult({
      root,
      result: evaluationResult(),
      input,
      today: "2026-08-27",
      postedAt: "2026-08-20",
      runId: "persist-one",
      runCommand: runCoreCommand,
    });
    const secondResult = evaluationResult({ score: 4.6, next_action: "Prepare the platform reliability interview story" });
    secondResult.tracker.note = `Strong${"\t".repeat(50_000)}| safe`;
    const second = await persistEvaluationResult({
      root,
      result: secondResult,
      input,
      today: "2026-08-27",
      postedAt: "2026-08-20",
      runId: "persist-two",
      runCommand: runCoreCommand,
    });

    assert.equal(first.reportNum, "001");
    assert.equal(second.reportNum, "002");
    assert.ok(fs.existsSync(path.join(root, first.reportPath)));
    assert.ok(fs.existsSync(path.join(root, second.reportPath)));

    const tracker = fs.readFileSync(path.join(root, "data", "applications.md"), "utf8");
    const dataRows = tracker.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
    assert.equal(dataRows.length, 1, "the same posting URL must update one tracker row");
    assert.match(dataRows[0], /4\.6\/5/);
    assert.match(dataRows[0], /002-acme-systems-2026-08-27\.md/);
    assert.match(dataRows[0], /Strong +\/ safe/);
    assert.doesNotMatch(dataRows[0], /\t/);
    assert.match(dataRows[0], /posted: 2026-08-20/);
    assert.deepEqual(fs.readdirSync(path.join(root, "reports")).filter((name) => /-RESERVED\.md$/.test(name)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
