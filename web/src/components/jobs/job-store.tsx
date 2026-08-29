"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import { readSavedCliId, resolveCliId } from "@/lib/saved-cli";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };
export type CvPositioning = "auto" | "agentic" | "fde";
export type JobStatus = "queued" | "running" | "persisting" | "done" | "error" | "cancelled";

export const isJobActive = (job: Pick<Job, "status">) =>
  job.status === "queued" || job.status === "running" || job.status === "persisting";

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  positioning?: CvPositioning;
  resolvedPositioning?: Exclude<CvPositioning, "auto">;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: JobStatus;
  stage?: string;
  error?: string;
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  startedAt: number;
  endedAt?: number;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string; positioning?: CvPositioning };

type Ctx = {
  jobs: Job[];
  startJob: (opts: StartOpts) => string | null;
  cancelJob: (id: string) => void;
  removeJob: (id: string) => void;
  clearFinished: () => void;
};

const JobsContext = createContext<Ctx | null>(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

const JOBS_KEY = "career-ops:jobs";

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const seq = useRef(0);
  const loaded = useRef(false);
  const controllers = useRef(new Map<string, AbortController>());

  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // A browser reload aborts its requests. Mark every non-terminal stage
        // interrupted instead of reviving work the client no longer owns.
        const now = Date.now();
        setJobs(arr.map((j: Job) => (isJobActive(j) ? {
          ...j,
          status: "error",
          stage: j.stage || j.status,
          error: "Interrupted (page reloaded)",
          endedAt: now,
          steps: [...(j.steps || []), { kind: "status", label: "Interrupted (page reloaded)", ts: now }],
        } : j)));
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);

  // persist
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 40)));
    } catch {
      /* quota */
    }
  }, [jobs]);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      const id = `job-${Date.now()}-${seq.current++}`;
      const startedAt = Date.now();
      const initialStatus: JobStatus = opts.kind === "evaluate" ? "queued" : "running";
      const initialLabel = initialStatus === "queued" ? "Queued for scoring" : "Starting…";
      const job: Job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        positioning: opts.positioning,
        batchId: opts.batchId,
        status: initialStatus,
        stage: initialStatus,
        steps: [{ kind: "status", label: initialLabel, ts: startedAt }],
        text: "",
        startedAt,
      };
      setJobs((js) => [job, ...js]);

      (async () => {
        let text = "";
        let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
        let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
        let doneCostUsd: number | null = null;
        let donePositioning: "agentic" | "fde" | undefined;
        let sawDone = false;
        let terminal = false;
        let stage: string = initialStatus;
        const steps: JobStep[] = [{ kind: "status", label: initialLabel, ts: startedAt }];
        const abortController = new AbortController();
        controllers.current.set(id, abortController);
        const finish = (status: "done" | "error" | "cancelled", lastLabel?: string) => {
          if (terminal) return;
          terminal = true;
          controllers.current.delete(id);
          const endedAt = Date.now();
          const finalStep = lastLabel ? { kind: "status" as const, label: lastLabel, ts: endedAt } : null;
          if (finalStep) steps.push(finalStep);
          const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
          const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
          patch(id, (j) => ({
            ...j,
            status,
            stage,
            error: status === "error" ? lastLabel : undefined,
            result,
            cost,
            resolvedPositioning: donePositioning ?? j.resolvedPositioning,
            endedAt,
            steps: finalStep ? [...j.steps, finalStep] : j.steps,
          }));
          // Save every terminal outcome. The server strips sensitive URL parts,
          // bounds all fields, and never writes the full evaluation payload.
          fetch("/api/runs/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id,
              title: opts.title,
              subtitle: opts.subtitle,
              page: opts.page,
              input: opts.input,
              status,
              stage,
              elapsedMs: endedAt - startedAt,
              error: status === "error" ? lastLabel : undefined,
              result,
              cost,
              steps,
              output: text,
            }),
          }).catch(() => {});
          if (status === "done") {
            // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
            // worker just wrote a real tracker row / report they don't yet see.
            if (typeof window !== "undefined" && (opts.kind === "evaluate" || opts.kind === "pdf")) {
              window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
            }
          }
        };

        try {
          const cliId = readSavedCliId() || (await resolveCliId());
          if (!cliId) {
            stage = initialStatus;
            finish("error", "No CLI configured — open Config and click Save config");
            return;
          }
          const res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId, positioning: opts.positioning, runId: id }),
            signal: abortController.signal,
          });
          if (!res.ok || !res.body) {
            const e = await res.json().catch(() => ({}));
            stage = initialStatus;
            finish("error", e.error || "Failed to start");
            return;
          }
          if (opts.kind === "evaluate") {
            stage = "running";
            const startedStep = { kind: "status" as const, label: "Scoring started", ts: Date.now() };
            steps.push(startedStep);
            patch(id, (j) => ({ ...j, status: "running", stage, steps: [...j.steps, startedStep] }));
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type === "tool") {
                  steps.push({ kind: "tool", label: ev.name, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name, ts: Date.now() }] }));
                } else if (ev.type === "status") {
                  if (ev.stage === "running" || ev.stage === "persisting") stage = ev.stage;
                  steps.push({ kind: "status", label: ev.label, ts: Date.now() });
                  patch(id, (j) => ({
                    ...j,
                    status: stage === "persisting" ? "persisting" : j.status,
                    stage,
                    steps: [...j.steps, { kind: "status", label: ev.label, ts: Date.now() }],
                  }));
                } else if (ev.type === "text") {
                  const full = text + ev.text;
                  const vm = full.match(/VERDICT:[^\n]*/i);
                  if (vm) verdictLine = vm[0];
                  text = full.slice(-8000);
                  patch(id, (j) => ({ ...j, text }));
                } else if (ev.type === "done") {
                  sawDone = true;
                  if (typeof ev.tokens === "number") doneTokens = ev.tokens;
                  if (typeof ev.costUsd === "number") doneCostUsd = ev.costUsd;
                  if (ev.positioning === "agentic" || ev.positioning === "fde") donePositioning = ev.positioning;
                } else if (ev.type === "error") {
                  if (typeof ev.stage === "string") stage = ev.stage;
                  finish("error", ev.msg || "Error");
                  return;
                }
              } catch {
                /* skip */
              }
            }
          }
          if (sawDone) {
            stage = "done";
            finish("done", "Done — report and tracker confirmed");
          } else {
            finish("error", "Run ended without an authoritative completion event");
          }
        } catch (error) {
          if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            finish("cancelled", "Cancelled");
          } else {
            finish("error", "Connection error");
          }
        }
      })();

      return id;
    },
    [patch],
  );

  const cancelJob = useCallback((id: string) => {
    patch(id, (j) => isJobActive(j)
      ? { ...j, steps: [...j.steps, { kind: "status", label: "Cancelling process tree", ts: Date.now() }] }
      : j);
    controllers.current.get(id)?.abort("user cancelled");
  }, [patch]);
  const removeJob = useCallback((id: string) => setJobs((js) => js.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => setJobs((js) => js.filter(isJobActive)), []);

  return <JobsContext.Provider value={{ jobs, startJob, cancelJob, removeJob, clearFinished }}>{children}</JobsContext.Provider>;
}
