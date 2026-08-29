// tests/pipeline-lock-mkdir-eperm.test.mjs — POSIX permission failures surface
// immediately instead of being reported as lock contention.
//
// mkdir's "someone else already has this" answer is not portable. POSIX gives
// EEXIST; Windows gives EPERM/EACCES when the target is mid-flight, being
// created or removed by another process at that instant. acquirePipelineLock
// used to rethrow anything that was not EEXIST, so on windows-latest one of 30
// concurrent `agent-inbox add` processes died with
//
//   EPERM: operation not permitted, mkdir '…\agent-inbox.md.lock.recover'
//
// and its queued item was never appended. Two earlier attempts at that failure
// raised the retry budget instead (#2506, #2825), because a starving writer and
// a writer killed by EPERM both surface as `kept=29 of 30` and only the second
// one is a crash.
//
// Windows can answer EPERM/EACCES for transient lock-directory churn, but macOS
// and Linux use those codes for a real permissions problem. Retrying one until
// timeout hides the reason sandboxed writers failed.

import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';
import { acquirePipelineLock } from '../pipeline-lock.mjs';

console.log('\n🔒 pipeline-lock: POSIX mkdir permission failures surface immediately');

// Two environments cannot produce the refusal this case needs, and in both a
// green result would mean nothing. Skipping loudly beats asserting nothing
// quietly.
//
//   - root: permission bits do not apply, so mkdir simply succeeds.
//   - win32: a POSIX mode of 0o500 does not stop directory creation there.
//     Windows uses ACLs, `chmod` maps onto the read-only attribute, and that
//     attribute does not deny mkdir inside the directory, so acquisition
//     succeeds and no error is thrown at all. Measured, not assumed: this
//     case failed on windows-latest with `got undefined` while the real
//     Windows EPERM it defends against was already gone from the same run.
//
const cannotRefuse = (typeof process.getuid === 'function' && process.getuid() === 0)
  ? 'running as root, permission bits do not apply'
  : (process.platform === 'win32' ? 'win32: a POSIX mode cannot deny mkdir, so the refusal never happens' : null);

if (cannotRefuse) {
  console.log(`  ⏭  skipped: ${cannotRefuse}`);
} else {
  const base = mkdtempSync(join(tmpdir(), 'co-lock-eperm-'));
  const sealed = join(base, 'sealed');
  mkdirSync(sealed);
  const pipelinePath = join(sealed, 'pipeline.md');
  chmodSync(sealed, 0o500); // r-x: mkdir inside is refused with EACCES

  try {
    let thrown = null;
    try {
      await acquirePipelineLock(pipelinePath, { timeoutMs: 300, retryMs: 20 });
    } catch (err) {
      thrown = err;
    }

    if (thrown?.code === 'EACCES' || thrown?.code === 'EPERM') {
      pass(`a refused mkdir surfaces its permission error immediately (${thrown.code})`);
    } else {
      fail(`expected EACCES/EPERM, got ${thrown?.name}: ${thrown?.code ?? ''} ${thrown?.message ?? ''}`);
    }
  } finally {
    chmodSync(sealed, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
}
