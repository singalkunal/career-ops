import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as yaml from "js-yaml";

export const EVALUATION_SCHEMA_VERSION = "career-ops-evaluation/v1";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const TOP_KEYS = ["schema_version", "status", "error", "report_markdown", "machine_summary", "tracker"];
const MACHINE_KEYS = [
  "company", "role", "score", "legitimacy_tier", "archetype", "final_decision",
  "hard_stops", "soft_gaps", "top_strengths", "risk_level", "confidence",
  "next_action", "work_auth", "discard_reasons", "via", "company_confidential",
  "advertised_comp", "reports_to", "risk_summary",
];
const RISK_KEYS = ["legitimacy", "classification", "culture", "interview_redflags", "ai_infra", "ai_screening_disclosure"];

const enumOf = (value, choices, field) => {
  if (!choices.includes(value)) throw new Error(`${field} has an unsupported value`);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, keys, field) {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${field} has missing or extra fields`);
  }
}

function text(value, field, { min = 0, max = 1_000 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`${field} must be a string between ${min} and ${max} characters`);
  }
}

function optionalText(value, field, max) {
  if (value !== null) text(value, field, { max });
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${field} must be an array`);
  value.forEach((item, index) => text(item, `${field}[${index}]`, { max: 1_000 }));
}

function validateMachine(machine) {
  exactKeys(machine, MACHINE_KEYS, "machine_summary");
  text(machine.company, "machine_summary.company", { min: 1, max: 200 });
  text(machine.role, "machine_summary.role", { min: 1, max: 300 });
  if (typeof machine.score !== "number" || !Number.isFinite(machine.score) || machine.score < 0 || machine.score > 5) {
    throw new Error("machine_summary.score must be between 0 and 5");
  }
  enumOf(machine.legitimacy_tier, ["High Confidence", "Proceed with Caution", "Suspicious"], "machine_summary.legitimacy_tier");
  text(machine.archetype, "machine_summary.archetype", { min: 1, max: 300 });
  enumOf(machine.final_decision, ["Apply", "Consider", "Research first", "Skip"], "machine_summary.final_decision");
  for (const field of ["hard_stops", "soft_gaps", "top_strengths", "discard_reasons"]) stringArray(machine[field], `machine_summary.${field}`);
  enumOf(machine.risk_level, ["Low", "Medium", "High"], "machine_summary.risk_level");
  enumOf(machine.confidence, ["Low", "Medium", "High"], "machine_summary.confidence");
  text(machine.next_action, "machine_summary.next_action", { min: 1, max: 1_000 });
  enumOf(machine.work_auth, ["sponsors", "not_needed", "unstated", "no_sponsorship"], "machine_summary.work_auth");
  optionalText(machine.via, "machine_summary.via", 200);
  if (typeof machine.company_confidential !== "boolean") throw new Error("machine_summary.company_confidential must be boolean");
  optionalText(machine.advertised_comp, "machine_summary.advertised_comp", 500);
  optionalText(machine.reports_to, "machine_summary.reports_to", 500);
  exactKeys(machine.risk_summary, RISK_KEYS, "machine_summary.risk_summary");
  enumOf(machine.risk_summary.legitimacy, ["high_confidence", "proceed_with_caution", "suspicious"], "risk_summary.legitimacy");
  enumOf(machine.risk_summary.classification, ["clear", "flagged", "not_evaluated"], "risk_summary.classification");
  enumOf(machine.risk_summary.culture, ["pass", "caution", "fail", "not_evaluated"], "risk_summary.culture");
  enumOf(machine.risk_summary.interview_redflags, ["none", "caution", "warning", "not_evaluated"], "risk_summary.interview_redflags");
  enumOf(machine.risk_summary.ai_infra, ["consistent", "mismatch", "not_evaluated"], "risk_summary.ai_infra");
  enumOf(machine.risk_summary.ai_screening_disclosure, ["disclosed", "corroborating_only", "no_match", "not_evaluated"], "risk_summary.ai_screening_disclosure");
}

function extractMachineSummary(markdown) {
  const match = markdown.match(/^## Machine Summary[ \t]*\r?\n+[ \t]*```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```/m);
  if (!match) throw new Error("report_markdown is missing the Machine Summary YAML fence");
  const parsed = yaml.load(match[1]);
  if (!isObject(parsed)) throw new Error("report Machine Summary YAML must be an object");
  return parsed;
}

function validateReport(report, machine) {
  text(report, "report_markdown", { min: 200, max: 500_000 });
  if (!/^# Evaluation:\s+.+\s+[—-]\s+.+$/m.test(report)) throw new Error("report_markdown is missing the evaluation title");
  for (const label of ["Date", "URL", "Archetype", "Score", "Legitimacy", "Work Auth", "PDF"]) {
    if (!new RegExp(`^\\*\\*${label}:\\*\\*`, "m").test(report)) throw new Error(`report_markdown is missing the ${label} header`);
  }
  for (const letter of ["A", "B", "C", "D", "E", "F", "G"]) {
    if (!new RegExp(`^##\\s+(?:Block\\s+)?${letter}(?:\\)|\\.|:|\\s|[—-])`, "m").test(report)) {
      throw new Error(`report_markdown is missing block ${letter}`);
    }
  }
  for (const heading of ["Risk Summary", "Cover Letter Draft"]) {
    if (!new RegExp(`^## ${heading}[ \\t]*$`, "m").test(report)) throw new Error(`report_markdown is missing ${heading}`);
  }
  if (!/^## (?:Keywords extracted|Extracted Keywords)[ \t]*$/mi.test(report)) throw new Error("report_markdown is missing extracted keywords");
  const score = report.match(/^\*\*Score:\*\*[ \t]*([0-5](?:\.\d+)?)\s*\/\s*5/m);
  if (!score || Number(score[1]) !== machine.score) throw new Error("report score does not match machine_summary.score");
  const yamlMachine = extractMachineSummary(report);
  if (!isDeepStrictEqual(yamlMachine, machine)) throw new Error("report Machine Summary does not match machine_summary");
}

/** Parse and validate the only result a scoring worker may return. */
export function parseEvaluationResult(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("evaluation result is empty");
  let value;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error("evaluation result is not valid JSON");
  }
  exactKeys(value, TOP_KEYS, "evaluation result");
  if (value.schema_version !== EVALUATION_SCHEMA_VERSION) throw new Error("evaluation result schema_version is unsupported");
  enumOf(value.status, ["completed", "failed"], "evaluation result status");

  if (value.status === "failed") {
    text(value.error, "evaluation result error", { min: 1, max: 1_000 });
    if (value.report_markdown !== null || value.machine_summary !== null || value.tracker !== null) {
      throw new Error("failed evaluation result must not include artifacts");
    }
    return value;
  }

  if (value.error !== null) throw new Error("completed evaluation result must have error: null");
  validateMachine(value.machine_summary);
  exactKeys(value.tracker, ["status", "note"], "tracker");
  if (value.tracker.status !== "Evaluated") throw new Error("tracker.status must be Evaluated");
  text(value.tracker.note, "tracker.note", { max: 1_000 });
  validateReport(value.report_markdown, value.machine_summary);
  return value;
}

/** Read a structured final payload from a Codex or Claude JSONL event. */
export function evaluationPayloadFromEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!isObject(event)) return null;
  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
    return event.item.text;
  }
  if (event.type === "result") {
    if (isObject(event.structured_output)) return JSON.stringify(event.structured_output);
    if (typeof event.result === "string" && event.result.trim()) return event.result;
  }
  return null;
}

/** Materialize the schema under the gitignored runtime dir for CLI flags. */
export function ensureEvaluationSchemaFile(root) {
  const source = path.join(MODULE_DIR, "evaluation-result.schema.json");
  const content = fs.readFileSync(source, "utf8");
  const dir = path.join(root, ".career-ops-web", "runtime");
  const target = path.join(dir, "evaluation-result.schema.json");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  return target;
}

export function readEvaluationSchema() {
  const source = path.join(MODULE_DIR, "evaluation-result.schema.json");
  return JSON.parse(fs.readFileSync(source, "utf8"));
}
