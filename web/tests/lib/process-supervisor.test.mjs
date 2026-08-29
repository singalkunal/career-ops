import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSupervised } from "../../src/lib/process-supervisor.mjs";

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition timed out");
};

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("cancellation terminates an ignored-SIGTERM process group and its descendant", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-tree-"));
  const pidFile = path.join(root, "pids.txt");
  const script = `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.CAREER_OPS_TEST_PID_FILE, process.pid + "," + descendant.pid);
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `;
  const supervised = spawnSupervised(process.execPath, ["-e", script], {
    stdio: "ignore",
    env: { ...process.env, CAREER_OPS_TEST_PID_FILE: pidFile },
  }, { graceMs: 100 });
  try {
    await waitFor(() => fs.existsSync(pidFile));
    const pids = fs.readFileSync(pidFile, "utf8").split(",").map(Number);
    assert.ok(pids.every(processAlive));
    const close = once(supervised.child, "close");
    const result = await supervised.terminate("test cancellation");
    await close;
    await waitFor(() => pids.every((pid) => !processAlive(pid)));
    assert.equal(result.forced, true);
    assert.equal(result.survived, false);
  } finally {
    try { await supervised.terminate("test cleanup"); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
