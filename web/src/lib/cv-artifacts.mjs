/** Exact report-to-CV lookup for View and Apply. */
import fs from "node:fs";
import path from "node:path";
import { RESOLVED_CV_POSITIONINGS } from "./cv-positioning.mjs";

const normReport = (value) => String(value ?? "").trim().replace(/^0+(?=\d)/, "");

function workspaceRelative(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** @param {string} file */
export function reportNumberFromFile(file) {
  const match = path.basename(String(file ?? "")).match(/^(\d+)-/);
  return match ? normReport(match[1]) : null;
}

/**
 * @param {string} text
 * @returns {Map<string,{reportNum:string,pdf:string,html:string,format:string,date:string,positioning:"agentic"|"fde"|null}>}
 */
export function parsePdfArtifacts(text) {
  const artifacts = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [report, pdf, html = "", format = "", date = "", rawPositioning = ""] = line.split("\t");
    const reportNum = normReport(report);
    if (!/^\d+$/.test(reportNum) || !pdf?.trim()) continue;
    const positioning = RESOLVED_CV_POSITIONINGS.has(rawPositioning.trim().toLowerCase())
      ? rawPositioning.trim().toLowerCase()
      : null;
    artifacts.set(reportNum, { reportNum, pdf: pdf.trim(), html, format, date, positioning });
  }
  return artifacts;
}

function safePdf(root, candidate) {
  try {
    if (path.extname(candidate).toLowerCase() !== ".pdf") return null;
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) return null;
    if (!fs.statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

/**
 * Resolve the exact PDF recorded for one report number.
 * @param {string} root
 * @param {string} reportNum
 */
export function resolvePdfArtifact(root, reportNum) {
  const key = normReport(reportNum);
  if (!/^\d+$/.test(key)) return null;
  let index;
  try {
    index = fs.readFileSync(path.join(root, "data", "pdf-index.tsv"), "utf8");
  } catch {
    return null;
  }
  const entry = parsePdfArtifacts(index).get(key);
  if (!entry) return null;
  const resolved = safePdf(root, path.resolve(root, entry.pdf));
  if (!resolved) return null;
  return {
    path: resolved,
    filename: path.basename(resolved),
    reportNum: key,
    positioning: entry.positioning,
    source: "manifest",
  };
}

/**
 * Pasted-URL fallback: attach only when the company has exactly one candidate
 * PDF. More than one is ambiguous and must never be resolved by recency.
 * @param {string} root
 * @param {string} company
 */
export function resolveUniqueCompanyPdf(root, company) {
  const slug = (String(company ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
  if (!slug) return null;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  const dir = path.join(root, "output");
  let matches;
  try {
    matches = fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith(".pdf") && boundary.test(file));
  } catch {
    return null;
  }
  if (matches.length !== 1) return null;
  const resolved = safePdf(root, path.join(dir, matches[0]));
  if (!resolved) return null;
  return {
    path: resolved,
    filename: path.basename(resolved),
    reportNum: null,
    positioning: null,
    source: "company",
  };
}

/** Record a rendered HTML- or LaTeX-backed CV in the shared PDF manifest. */
export function recordPdfArtifact(root, { reportNum, pdfPath, sourcePath, format, positioning }) {
  const key = normReport(reportNum);
  const relPdf = workspaceRelative(root, pdfPath);
  const relSource = workspaceRelative(root, sourcePath);
  if (!/^\d+$/.test(key) || !relPdf || !relSource || !RESOLVED_CV_POSITIONINGS.has(positioning)) {
    return { ok: false, error: "Invalid report number, artifact path, or CV positioning." };
  }
  const file = path.join(root, "data", "pdf-index.tsv");
  try {
    let rows = [];
    try {
      rows = fs.readFileSync(file, "utf8").split("\n").filter((line) => {
        if (!line.trim() || line.startsWith("#")) return false;
        const fields = line.split("\t");
        return normReport(fields[0]) !== key && fields[1] !== relPdf;
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    rows.push([key, relPdf, relSource, format, new Date().toISOString().slice(0, 10), positioning].join("\t"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      "# report\tpdf\thtml\tformat\tdate\tpositioning — written by generate-pdf.mjs, do not edit\n"
        + rows.join("\n") + "\n",
      "utf8",
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not record the tailored CV: ${error.message}` };
  }
}

/**
 * Add the resolved positioning to the manifest row generate-pdf.mjs just wrote.
 * @param {string} root
 * @param {string} reportNum
 * @param {"agentic"|"fde"} positioning
 * @returns {{ok:true}|{ok:false,error:string}}
 */
export function recordPdfPositioning(root, reportNum, positioning) {
  const key = normReport(reportNum);
  if (!/^\d+$/.test(key) || !RESOLVED_CV_POSITIONINGS.has(positioning)) {
    return { ok: false, error: "Invalid report number or CV positioning." };
  }
  const file = path.join(root, "data", "pdf-index.tsv");
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("# report\t")) {
        return "# report\tpdf\thtml\tformat\tdate\tpositioning — written by generate-pdf.mjs, do not edit";
      }
      if (line.startsWith("#")) return line;
      const fields = line.split("\t");
      if (normReport(fields[0]) !== key) return line;
      while (fields.length < 6) fields.push("");
      fields[5] = positioning;
      found = true;
      return fields.join("\t");
    });
    if (!found) return { ok: false, error: `No PDF manifest row exists for report #${reportNum}.` };
    fs.writeFileSync(file, updated.join("\n"), "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not record CV positioning: ${error.message}` };
  }
}
