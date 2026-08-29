import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

const redactSecrets = (value) => String(value ?? "")
  .replace(/\b(?:Bearer\s+)?(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
  .replace(/\b(api[_ -]?key|access[_ -]?token|authorization|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");

export function sanitizeLogText(value, max = 1_000) {
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

export function sanitizeLogInput(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.split("/").map((segment) => (
      /^[A-Za-z0-9_-]{32,}$/.test(segment) ? "[redacted]" : segment
    )).join("/");
    return url.toString();
  } catch {
    return "[non-URL input omitted]";
  }
}

export function buildRunLog(body) {
  const id = String(body.id ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 160);
  if (!id) throw new Error("id required");
  const status = TERMINAL_STATUSES.has(body.status) ? body.status : "error";
  const stage = sanitizeLogText(body.stage || status, 120).replace(/\n/g, " ");
  const error = status === "error" ? sanitizeLogText(body.error || "Unknown error", 500).replace(/\n/g, " ") : "";
  const elapsedMs = Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0
    ? Math.round(body.elapsedMs)
    : 0;
  const score = Number.isFinite(body.result?.score) ? `${body.result.score}/5` : "-";
  const summary = sanitizeLogText(body.result?.summary, 300).replace(/\n/g, " ");
  const steps = Array.isArray(body.steps)
    ? body.steps.slice(-100).map((step) => {
        const kind = step?.kind === "tool" ? "tool" : "status";
        return `- [${kind}] ${sanitizeLogText(step?.label, 300).replace(/\n/g, " ")}`;
      }).join("\n")
    : "";
  const output = sanitizeLogText(body.output, 8_000);
  const title = sanitizeLogText(body.title || id, 300).replace(/\n/g, " ");
  const page = sanitizeLogText(body.page || "-", 300).replace(/\n/g, " ");

  return {
    id,
    markdown: `# Web run: ${title}

- id: ${id}
- status: ${status}
- stage: ${stage || status}
- elapsed_ms: ${elapsedMs}
- page: ${page}
- input: ${sanitizeLogInput(body.input)}
- verdict: ${score}${summary ? ` - ${summary}` : ""}
- error: ${error || "-"}

## Steps

${steps || "- none recorded"}

## Output

${output || "-"}
`,
  };
}

export function writeRunLog(dir, body) {
  const { id, markdown } = buildRunLog(body);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.md`);
  const tmp = path.join(dir, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, markdown, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* renamed */ }
  }
  return target;
}
