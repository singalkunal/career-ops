import { readEvaluationSchema } from "./evaluation-result.mjs";

const READ_ONLY_TOOLS = "Read,WebFetch,WebSearch,Glob,Grep";
const DENIED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,Bash,Task";

export class UnsupportedEvaluationRuntimeError extends Error {
  constructor(cliId) {
    super(`The ${cliId} runtime cannot enforce Career Ops' read-only structured evaluation contract. Use Codex or Claude Code for scoring.`);
    this.name = "UnsupportedEvaluationRuntimeError";
  }
}

/**
 * Build the audited scoring invocation. This is intentionally separate from a
 * CLI's general-purpose argv: scoring has a stricter output and permission
 * contract than research, PDF tailoring, or config repair.
 */
export function evaluationInvocation({ cliId, prompt, schemaPath }) {
  if (cliId === "codex") {
    return {
      format: "jsonl",
      args: [
        "--search",
        "exec",
        "--strict-config",
        "--ignore-user-config",
        "-c", 'approval_policy="never"',
        "--sandbox", "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
        "--output-schema", schemaPath,
        "--json",
        "--color", "never",
        prompt,
      ],
    };
  }

  if (cliId === "claude") {
    return {
      format: "jsonl",
      args: [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--permission-mode", "dontAsk",
        "--strict-mcp-config",
        "--allowedTools", READ_ONLY_TOOLS,
        "--disallowedTools", DENIED_TOOLS,
        "--json-schema", JSON.stringify(readEvaluationSchema()),
      ],
    };
  }

  throw new UnsupportedEvaluationRuntimeError(cliId);
}
