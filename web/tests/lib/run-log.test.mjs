import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRunLog } from "../../src/lib/run-log.mjs";

test("failed run logs record stage, elapsed time, and a sanitized error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-log-"));
  try {
    const file = writeRunLog(dir, {
      id: "job-failed-1",
      title: "Evaluation",
      input: "https://example.com/jobs/7?token=secret-value#private",
      status: "error",
      stage: "persisting",
      elapsedMs: 12_345,
      error: "authorization=secret-value merge failed",
      output: "Bearer sk-supersecretvalue123456789",
      steps: [{ kind: "status", label: "Persisting report" }],
    });
    const log = fs.readFileSync(file, "utf8");
    assert.match(log, /- status: error/);
    assert.match(log, /- stage: persisting/);
    assert.match(log, /- elapsed_ms: 12345/);
    assert.match(log, /authorization=\[redacted\]/);
    assert.match(log, /https:\/\/example\.com\/jobs\/7/);
    assert.ok(!log.includes("secret-value"));
    assert.ok(!log.includes("supersecret"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelled run logs omit a private non-URL prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-log-"));
  try {
    const file = writeRunLog(dir, {
      id: "job-cancelled-1",
      title: "Evaluation",
      input: "private pasted job description",
      status: "cancelled",
      stage: "queued",
      elapsedMs: 50,
    });
    const log = fs.readFileSync(file, "utf8");
    assert.match(log, /- status: cancelled/);
    assert.match(log, /\[non-URL input omitted\]/);
    assert.ok(!log.includes("private pasted job description"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run logs redact opaque URL path credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-log-"));
  try {
    const secret = "a_very_long_private_path_credential_123456789";
    const file = writeRunLog(dir, {
      id: "job-path-secret",
      input: `https://example.com/jobs/${secret}`,
      status: "cancelled",
      stage: "running",
      elapsedMs: 1,
    });
    const log = fs.readFileSync(file, "utf8");
    assert.ok(!log.includes(secret));
    assert.match(log, /jobs\/\[redacted\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
