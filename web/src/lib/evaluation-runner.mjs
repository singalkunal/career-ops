import { randomUUID } from "node:crypto";
import path from "node:path";
import { evaluationInvocation, UnsupportedEvaluationRuntimeError } from "./evaluation-cli.mjs";
import { resolveEvaluationPosting } from "./evaluation-posting-source.mjs";
import { ensureEvaluationSchemaFile, evaluationPayloadFromEvent, parseEvaluationResult } from "./evaluation-result.mjs";
import { persistEvaluationResult } from "./evaluation-persistence.mjs";
import { buildPrompt } from "./run-prompts.mjs";
import { scoringQueue } from "./scoring-queue.mjs";
import { spawnSupervised } from "./process-supervisor.mjs";
import { accumulateTokens, isFatalGenericStderr } from "./run-cli-support.mjs";
import { sanitizeLogText, writeRunLog } from "./run-log.mjs";

const jsonError = (message, status) => new Response(JSON.stringify({ error: message }), {
  status,
  headers: { "Content-Type": "application/json" },
});

/** Run one queued, read-only evaluation and persist only its validated result. */
export async function runEvaluationRequest({
  request,
  input,
  cliId,
  spec,
  binPath,
  promptArgs,
  root,
  today,
  postedAt,
  runId,
}) {
  const effectiveRunId = runId || randomUUID();
  const startedAt = Date.now();
  let terminalLogged = false;
  let logStage = "queued";
  const logTerminal = (status, error = "") => {
    if (terminalLogged) return;
    terminalLogged = true;
    try {
      writeRunLog(path.join(root, ".career-ops-web", "runs"), {
        id: effectiveRunId,
        title: "Evaluation worker",
        input,
        status,
        stage: logStage,
        elapsedMs: Date.now() - startedAt,
        error,
        steps: [{ kind: "status", label: logStage }],
        output: "",
      });
    } catch (logError) {
      console.error("Could not persist the evaluation run log", {
        runId: effectiveRunId,
        status,
        error: logError instanceof Error ? logError.message : String(logError),
      });
    }
  };
  let lease;
  try {
    lease = await scoringQueue.acquire(request.signal);
  } catch {
    logTerminal("cancelled");
    return jsonError("Scoring request cancelled while queued", 499);
  }

  if (request.signal.aborted) {
    lease.release();
    logTerminal("cancelled");
    return jsonError("Scoring request cancelled while queued", 499);
  }
  logStage = "retrieving official posting";
  let postingSource;
  try {
    postingSource = await resolveEvaluationPosting(input, {
      companyHint: promptArgs?.companyHint,
      signal: request.signal,
    });
  } catch (error) {
    postingSource = {
      status: "unavailable",
      error: error instanceof Error ? error.message : "Official posting retrieval failed",
    };
  }
  if (request.signal.aborted) {
    lease.release();
    logTerminal("cancelled");
    return jsonError("Scoring request cancelled while retrieving the posting", 499);
  }

  let invocation;
  try {
    invocation = evaluationInvocation({
      cliId,
      prompt: buildPrompt({ ...promptArgs, postingSource }),
      schemaPath: ensureEvaluationSchemaFile(root),
    });
  } catch (error) {
    lease.release();
    if (error instanceof UnsupportedEvaluationRuntimeError) return jsonError(error.message, 400);
    return jsonError(`Cannot prepare the evaluation contract: ${error.message}`, 500);
  }
  logStage = "running";

  const supervised = spawnSupervised(binPath, invocation.args, {
    cwd: root,
    env: process.env,
  });
  const { child } = supervised;
  child.stdin?.end();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let released = false;
  let closed = false;
  let cancelled = false;
  let timedOut = false;
  let stage = "running";
  let persistencePromise = null;

  const releaseLease = () => {
    if (released) return;
    released = true;
    lease.release();
  };

  const stream = new ReadableStream({
    start(controller) {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let payload = "";
      let streamedText = "";
      let sawFatalStderr = false;
      let runtimeError = "";
      let spawnError = null;
      let lastTokens = 0;
      let lastCostUsd = null;
      let heartbeat;
      let timeout;
      let settled = false;

      const send = (event) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { closed = true; }
      };
      const cleanupTimers = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
      };
      const close = () => {
        cleanupTimers();
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* client already closed */ }
        }
        releaseLease();
      };
      const fail = (message) => {
        logStage = stage;
        logTerminal("error", String(message));
        send({ type: "error", msg: String(message).slice(0, 500), stage });
        close();
      };
      const parseLine = (line) => {
        const structured = evaluationPayloadFromEvent(line);
        if (structured) payload = structured;
        let event = null;
        try { event = spec.parseEvent?.(line) ?? null; } catch { /* malformed runtime event */ }
        if (event?.text && !structured) streamedText += event.text;
        if (event?.tool) send({ type: "tool", name: event.tool });
        if (event?.status) send({ type: "status", label: event.status, stage: "running" });
        lastTokens = accumulateTokens(lastTokens, event);
        if (typeof event?.costUsd === "number") lastCostUsd = event.costUsd;
        if (event?.error) {
          sawFatalStderr = true;
          runtimeError = sanitizeLogText(event.error, 400).replace(/\n/g, " ");
          send({ type: "status", label: "Evaluator reported an error", stage: "running" });
        }
      };
      const flushOutput = () => {
        const trailing = stdoutBuffer.trim();
        if (trailing) parseLine(trailing);
        stdoutBuffer = "";
        const stderrTrailing = stderrBuffer.trim();
        if (stderrTrailing && (spec.stderrIsFatal ?? isFatalGenericStderr)(stderrTrailing)) sawFatalStderr = true;
        stderrBuffer = "";
      };

      send({ type: "status", label: "Scoring role", stage: "running" });
      if (postingSource.status === "resolved") {
        send({ type: "status", label: "Official ATS posting loaded", stage: "running" });
      } else if (postingSource.status === "unavailable") {
        send({ type: "status", label: "Official ATS fetch unavailable; using web fallback", stage: "running" });
      }
      heartbeat = setInterval(() => send({ type: "keepalive" }), 10_000);
      timeout = setTimeout(() => {
        timedOut = true;
        stage = "running";
        void supervised.terminate("timeout");
      }, 600_000);

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        let newline;
        while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line) parseLine(line);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
        let newline;
        while ((newline = stderrBuffer.indexOf("\n")) !== -1) {
          const line = stderrBuffer.slice(0, newline);
          stderrBuffer = stderrBuffer.slice(newline + 1);
          if ((spec.stderrIsFatal ?? isFatalGenericStderr)(line)) sawFatalStderr = true;
        }
      });
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        void (async () => {
          cleanupTimers();
          await supervised.stopRemainingTree();
          flushOutput();
          if (cancelled) return close();
          if (timedOut) return fail("Scoring timed out; the evaluator process tree was terminated");
          if (spawnError) return fail(spawnError.message);
          if (code !== 0 || sawFatalStderr) {
            return fail(runtimeError
              ? `Evaluator failed: ${runtimeError}`
              : "The evaluator failed before producing a trustworthy result");
          }

          let result;
          try {
            result = parseEvaluationResult(payload || streamedText);
          } catch (error) {
            return fail(`Malformed evaluation result: ${error.message}`);
          }
          if (result.status === "failed") return fail(result.error);

          stage = "persisting";
          logStage = stage;
          send({ type: "status", label: "Persisting report and tracker", stage });
          persistencePromise = persistEvaluationResult({
            root,
            result,
            input,
            today,
            postedAt,
            runId: effectiveRunId,
            signal: abortController.signal,
          });
          try {
            const artifacts = await persistencePromise;
            if (cancelled) return close();
            stage = "done";
            logStage = stage;
            send({
              type: "text",
              text: `VERDICT: ${artifacts.score}/5 — ${result.machine_summary.next_action}\n`,
            });
            send({
              type: "done",
              tokens: lastTokens,
              costUsd: lastCostUsd,
              score: artifacts.score,
              company: artifacts.company,
              role: artifacts.role,
              reportPath: artifacts.reportPath,
              trackerNum: artifacts.trackerNum,
            });
            logTerminal("done");
            close();
          } catch (error) {
            if (cancelled || error?.name === "AbortError") return close();
            stage = error?.stage || stage;
            fail(error.message);
          }
        })();
      });

      const onRequestAbort = () => {
        cancelled = true;
        logStage = stage;
        logTerminal("cancelled");
        abortController.abort("client cancelled");
        void supervised.terminate("client cancelled");
      };
      request.signal.addEventListener("abort", onRequestAbort, { once: true });
    },
    cancel() {
      cancelled = true;
      closed = true;
      logStage = stage;
      logTerminal("cancelled");
      abortController.abort("client cancelled");
      void supervised.terminate("client cancelled").finally(() => {
        if (!persistencePromise) releaseLease();
      });
      persistencePromise?.finally(releaseLease);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
