import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 3_000;

function abortError(reason = "cancelled") {
  const error = new Error(typeof reason === "string" ? reason : "cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Supervise one child as a process tree.
 *
 * POSIX children lead a detached process group. Cancellation and timeout signal
 * the whole group, wait briefly, then send SIGKILL if any descendant remains.
 * Windows has no negative-pid process groups, so it uses taskkill's tree mode
 * without /F first, then repeats with /F after the grace period.
 */
export function spawnSupervised(command, args, options = {}, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? spawn;
  const killFn = deps.killFn ?? process.kill.bind(process);
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const useProcessGroup = platform !== "win32";
  const child = spawnFn(command, args, {
    ...options,
    detached: useProcessGroup,
  });

  let terminationPromise = null;
  let forceTimer;
  let settleTimer;

  const groupAlive = () => {
    if (!useProcessGroup || !child.pid) return false;
    try {
      killFn(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const directAlive = () => child.exitCode === null && child.signalCode === null;
  const treeAlive = () => useProcessGroup ? groupAlive() : directAlive();

  const signalPosixTree = (signal) => {
    if (child.pid) {
      try {
        killFn(-child.pid, signal);
        return true;
      } catch {
        // The group may have gone between the liveness check and the signal.
      }
    }
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const signalWindowsTree = (force = false) => {
    if (!child.pid) return;
    try {
      const args = ["/pid", String(child.pid), "/T"];
      if (force) args.push("/F");
      const killer = spawnFn("taskkill.exe", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref?.();
    } catch {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
    }
  };

  const clearTimers = () => {
    if (forceTimer) clearTimeout(forceTimer);
    if (settleTimer) clearTimeout(settleTimer);
    forceTimer = undefined;
    settleTimer = undefined;
  };

  const terminate = (reason = "cancelled") => {
    if (terminationPromise) return terminationPromise;
    terminationPromise = new Promise((resolve) => {
      let forced = false;
      let forceDeadline = 0;

      const poll = () => {
        if (!treeAlive() || (forced && Date.now() >= forceDeadline)) {
          clearTimers();
          resolve({ reason, forced, survived: treeAlive() });
          return;
        }
        settleTimer = setTimeout(poll, 25);
        settleTimer.unref?.();
      };

      forceTimer = setTimeout(() => {
        if (!treeAlive() && useProcessGroup) return;
        forced = true;
        forceDeadline = Date.now() + 2_000;
        if (useProcessGroup) signalPosixTree("SIGKILL");
        else signalWindowsTree(true);
      }, graceMs);
      forceTimer.unref?.();

      if (useProcessGroup) signalPosixTree("SIGTERM");
      else signalWindowsTree(false);
      poll();
    });
    return terminationPromise;
  };

  /** Kill descendants a normally-exited leader left behind. */
  const stopRemainingTree = async () => {
    if (useProcessGroup && groupAlive()) await terminate("descendant cleanup");
  };

  return { child, terminate, stopRemainingTree, treeAlive };
}

/** Run a bounded command and collect its output without leaving descendants. */
export function runSupervisedCommand(command, args, options = {}) {
  const {
    signal,
    timeoutMs = 75_000,
    maxOutputBytes = 1_000_000,
    supervisorDeps,
    ...spawnOptions
  } = options;
  const supervised = spawnSupervised(command, args, spawnOptions, supervisorDeps);
  const { child } = supervised;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdin?.end();

  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => (current + chunk).slice(-maxOutputBytes);
  child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void supervised.terminate("timeout");
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      void supervised.terminate("cancelled");
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const finish = async (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await supervised.stopRemainingTree();
      fn();
    };

    child.once("error", (error) => {
      void finish(() => reject(error));
    });
    child.once("close", (code, closeSignal) => {
      void finish(() => {
        if (aborted) return reject(abortError(signal?.reason));
        if (timedOut) return reject(new Error(`Command timed out after ${timeoutMs}ms`));
        if (code !== 0) {
          const detail = stderr.trim().slice(-2_000) || `signal ${closeSignal ?? "unknown"}`;
          return reject(new Error(`Command exited ${code ?? "without a code"}: ${detail}`));
        }
        resolve({ stdout, stderr, code: 0 });
      });
    });
  });
}
