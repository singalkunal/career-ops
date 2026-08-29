import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runSupervisedCommand } from "./process-supervisor.mjs";

const ISO_DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;

export class EvaluationPersistenceError extends Error {
  constructor(stage, cause) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "EvaluationPersistenceError";
    this.stage = stage;
    this.cause = cause;
  }
}

const safeField = (value, max = 1_000) => String(value ?? "")
  .replaceAll("\r", " ")
  .replaceAll("\n", " ")
  .replaceAll("\t", " ")
  .split("|")
  .map((part) => part.trim())
  .join(" / ")
  .trim()
  .slice(0, max);

function postingUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function companySlug(machine) {
  const source = machine.company_confidential
    ? `confidential-${machine.via || "unknown"}`
    : machine.company;
  const slug = String(source)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "unknown-company";
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite existing artifact ${file}`);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* renamed or best-effort cleanup */ }
  }
}

function workAuthHeader(value) {
  return {
    sponsors: "✅ Sponsors",
    not_needed: "➖ Not needed",
    unstated: "⚠️ Unstated",
    no_sponsorship: "⛔ No sponsorship",
  }[value];
}

function canonicalReport(result, { input, today }) {
  const machine = result.machine_summary;
  let report = result.report_markdown.replace(/\r\n/g, "\n").trim();
  const replacements = {
    Date: today,
    URL: postingUrl(input) || "N/A",
    Archetype: machine.archetype,
    Score: `${machine.score}/5`,
    Legitimacy: machine.legitimacy_tier,
    "Work Auth": workAuthHeader(machine.work_auth),
    PDF: "pending",
  };
  report = report.replace(/^# Evaluation:.*$/m, `# Evaluation: ${safeField(machine.company, 200)} — ${safeField(machine.role, 300)}`);
  for (const [label, value] of Object.entries(replacements)) {
    report = report.replace(new RegExp(`^\\*\\*${label}:\\*\\*.*$`, "m"), `**${label}:** ${value}`);
  }
  if (!/^\*\*Via:\*\*/m.test(report)) {
    report = report.replace(/^(\*\*URL:\*\*.*)$/m, `$1\n**Via:** ${safeField(machine.via, 200) || "—"}`);
  }
  return `${report}\n`;
}

function parseReservedNumber(stdout) {
  const matches = String(stdout).match(/(?:^|\n)(\d{3})(?=\n|$)/g) ?? [];
  const value = matches.at(-1)?.trim();
  if (!/^\d{3}$/.test(value ?? "")) throw new Error("reserve-report-num.mjs returned no 3-digit number");
  return value;
}

function buildTrackerLine({ reportNum, today, machine, tracker, filename, input, postedAt }) {
  let note = safeField(tracker.note);
  note = note.replace(/(?:^|;\s*)posted:\s*20\d{2}-\d{2}-\d{2}\b/gi, "").replace(/^;\s*|;\s*$/g, "").trim();
  if (ISO_DATE_RE.test(postedAt ?? "")) note = `${note}${note ? "; " : ""}posted: ${postedAt}`;
  const fields = [
    reportNum,
    today,
    safeField(machine.company, 200),
    safeField(machine.role, 300),
    "Evaluated",
    `${machine.score}/5`,
    "❌",
    `[${reportNum}](reports/${filename})`,
    note,
    postingUrl(input),
  ];
  if (machine.via) fields.push(`via=${safeField(machine.via, 200)}`);
  return `${fields.join("\t")}\n`;
}

function verifyArtifacts({ reportFile, reportContent, trackerFile, filename }) {
  if (!fs.existsSync(reportFile) || fs.readFileSync(reportFile, "utf8") !== reportContent) {
    throw new Error("authoritative report file does not match the validated result");
  }
  if (!fs.existsSync(trackerFile)) throw new Error("applications tracker does not exist after merge");
  const rows = fs.readFileSync(trackerFile, "utf8").split(/\r?\n/).filter((line) => line.includes(`reports/${filename}`));
  if (rows.length !== 1) throw new Error(`expected exactly one tracker row for ${filename}, found ${rows.length}`);
  const trackerNum = rows[0].split("|")[1]?.trim() || null;
  return { trackerNum };
}

/**
 * Persist one validated proposer result through the canonical core scripts.
 * The additions directory is isolated per run, so merge-tracker can consume
 * exactly this run's single TSV while still using its shared cross-process lock.
 */
export async function persistEvaluationResult({
  root,
  result,
  input,
  today,
  postedAt,
  runId,
  signal,
  runCommand = runSupervisedCommand,
}) {
  const safeRunId = safeField(runId, 120).replace(/[^a-z0-9_-]/gi, "") || randomUUID();
  const runtimeRoot = path.join(root, ".career-ops-web", "runtime");
  const additionsDir = path.join(runtimeRoot, "tracker-additions", safeRunId);
  const trackerFile = path.join(root, "data", "applications.md");
  const commandEnv = {
    ...process.env,
    CAREER_OPS_TRACKER: trackerFile,
    CAREER_OPS_REPORTS_DIR: path.join(root, "reports"),
    CAREER_OPS_ADDITIONS: additionsDir,
    CAREER_OPS_BATCH_STATE: path.join(additionsDir, "no-batch-state.tsv"),
  };
  let reportNum = null;
  let outcome = null;
  let failure = null;
  let stage = "reserving report number";

  try {
    fs.mkdirSync(additionsDir, { recursive: true });
    const reserved = await runCommand(process.execPath, [path.join(root, "reserve-report-num.mjs")], {
      cwd: root,
      env: commandEnv,
      signal,
      timeoutMs: 75_000,
    });
    reportNum = parseReservedNumber(reserved.stdout);

    stage = "writing report";
    const slug = companySlug(result.machine_summary);
    const filename = `${reportNum}-${slug}-${today}.md`;
    const reportFile = path.join(root, "reports", filename);
    const reportContent = canonicalReport(result, { input, today });
    atomicWrite(reportFile, reportContent);

    stage = "writing tracker proposal";
    const additionFile = path.join(additionsDir, `${reportNum}-${slug}.tsv`);
    atomicWrite(additionFile, buildTrackerLine({
      reportNum,
      today,
      machine: result.machine_summary,
      tracker: result.tracker,
      filename,
      input,
      postedAt,
    }));

    stage = "merging tracker row";
    await runCommand(process.execPath, [path.join(root, "merge-tracker.mjs")], {
      cwd: root,
      env: commandEnv,
      signal,
      timeoutMs: 75_000,
    });

    stage = "confirming artifacts";
    const confirmed = verifyArtifacts({ reportFile, reportContent, trackerFile, filename });
    outcome = {
      reportNum,
      reportFile,
      reportPath: `reports/${filename}`,
      trackerFile,
      trackerNum: confirmed.trackerNum,
      score: result.machine_summary.score,
      company: result.machine_summary.company,
      role: result.machine_summary.role,
    };
  } catch (error) {
    failure = error instanceof EvaluationPersistenceError ? error : new EvaluationPersistenceError(stage, error);
  } finally {
    if (reportNum) {
      try {
        await runCommand(process.execPath, [path.join(root, "reserve-report-num.mjs"), "--release", reportNum], {
          cwd: root,
          env: commandEnv,
          timeoutMs: 20_000,
        });
      } catch (error) {
        if (!failure) failure = new EvaluationPersistenceError("releasing report reservation", error);
      }
    }
    try { fs.rmSync(additionsDir, { recursive: true, force: true }); } catch { /* gitignored runtime cleanup */ }
  }
  if (failure) throw failure;
  return outcome;
}
