// tracker-lock.ts imports `@/lib/career-ops` (the path alias), which plain
// `node --test` cannot resolve without the Next.js build — same constraint as
// pipeline.ts, same workaround already established in
// tests/lib/pipeline-local-today.test.mjs: read the source and assert the
// shape of the catch block directly.
//
// Covers: withTrackerLock's acquire-failure catch used to be unconditional
// (`catch { throw new TrackerBusyError(); }`), converting EVERY error from
// acquiring the lock — including a genuine ENOENT from a missing lock-dir
// parent, or EACCES — into "tracker is being written by another process,
// retry". That is false for those cases: they never resolve by retrying. The
// sibling followups-lock.ts already gets this right (discriminates on the
// core's SeedError('LOCK_TIMEOUT')); tracker-lock.ts's core equivalent tags a
// plain Error with `.code = 'LOCK_TIMEOUT'` instead (tracker-utils.mjs), so
// the discriminator here is `err.code === 'LOCK_TIMEOUT'`.
//
// Run:  node --test tests/lib/tracker-lock-error-classification.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", "src", "lib", "core", "tracker-lock.ts");
const src = readFileSync(SRC, "utf8");

function acquireCatchBlock() {
  // The catch immediately after the `acquire(...)` call, up to its closing
  // brace before the `try { return await fn(); }` that follows.
  const m = src.match(/lock = await acquire\([\s\S]*?\}\)\s*;\s*\}\s*catch[\s\S]*?\n {2}\}/);
  assert.ok(m, `${SRC}: could not find the acquire()/catch block — the function was restructured. Update this extractor.`);
  return m[0];
}

test("the acquire-failure catch block still exists at the shape this test extracts", () => {
  assert.ok(acquireCatchBlock().length > 0);
});

test("a bare catch-all that converts every acquire error to TrackerBusyError is gone", () => {
  const block = acquireCatchBlock();
  assert.doesNotMatch(
    block,
    /catch\s*\{\s*throw new TrackerBusyError\(\);\s*\}/,
    `${SRC}: the acquire-failure catch is unconditional again — every error (ENOENT, EACCES, a broken ` +
      `checkout) gets reported as transient lock contention, which is false for anything that isn't ` +
      `LOCK_TIMEOUT. Discriminate on err.code before converting.`,
  );
});

test("TrackerBusyError is thrown only for the core's LOCK_TIMEOUT tag", () => {
  const block = acquireCatchBlock();
  assert.match(
    block,
    /err\s*&&\s*err\.code\s*===\s*["']LOCK_TIMEOUT["']/,
    `${SRC}: expected the catch to check err.code === 'LOCK_TIMEOUT' before throwing TrackerBusyError.`,
  );
});

test("anything not tagged LOCK_TIMEOUT propagates as-is, not swallowed", () => {
  const block = acquireCatchBlock();
  assert.match(
    block,
    /throw e;\s*\}\s*$/,
    `${SRC}: expected a final "throw e;" so a non-timeout error (e.g. ENOENT) reaches the caller ` +
      `unchanged instead of being converted or dropped.`,
  );
});

// --- Pins the underlying contract this fix depends on: the core function
// tracker-lock.ts wraps must NOT tag a non-contention failure as LOCK_TIMEOUT.
// Same core-resolution / skip-if-absent pattern as tracker-lock.test.mjs.

const CORE =
  process.env.CAREER_OPS_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coreLock = path.join(CORE, "tracker-utils.mjs");

let acquireTrackerLock = null;
let skipCore = false;
try {
  ({ acquireTrackerLock } = await import(pathToFileURL(coreLock).href));
} catch (err) {
  const coreAbsent = !fs.existsSync(coreLock);
  const packageUnresolvable = err.url == null;
  const depsAbsent = !fs.existsSync(path.join(CORE, "node_modules"));
  if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
  if (coreAbsent) skipCore = `no core checkout at ${CORE}`;
  else if (packageUnresolvable && depsAbsent) skipCore = `core dependencies are not installed at ${CORE} (web-only checkout)`;
  else throw err;
}

test("the core: a genuine ENOENT from acquireTrackerLock is NOT tagged LOCK_TIMEOUT", { skip: skipCore }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trklock-enoent-"));
  const lockDir = path.join(root, "lockdir");
  const enoent = Object.assign(new Error("missing lock parent"), { code: "ENOENT" });
  await assert.rejects(
    () => acquireTrackerLock(lockDir, {
      timeoutMs: 2_000,
      retryMs: 50,
      createLockDir: () => { throw enoent; },
    }),
    (err) => {
      assert.equal(err, enoent);
      assert.equal(err.code, "ENOENT");
      assert.notEqual(err.code, "LOCK_TIMEOUT", "a filesystem failure must not be mistaken for lock contention");
      return true;
    },
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "the core: POSIX EACCES propagates immediately instead of becoming LOCK_TIMEOUT",
  { skip: skipCore || process.platform === "win32" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trklock-eacces-"));
    const lockDir = path.join(root, "lockdir");
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    try {
      const started = Date.now();
      await assert.rejects(
        () => acquireTrackerLock(lockDir, {
          timeoutMs: 2_000,
          retryMs: 20,
          createLockDir: () => { throw permissionError; },
        }),
        (err) => {
          assert.equal(err, permissionError);
          assert.equal(err.code, "EACCES");
          assert.notEqual(err.code, "LOCK_TIMEOUT");
          return true;
        },
      );
      assert.ok(Date.now() - started < 500, "permission failure was treated as contention");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
