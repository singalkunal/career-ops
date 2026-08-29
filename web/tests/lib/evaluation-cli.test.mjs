import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluationInvocation, UnsupportedEvaluationRuntimeError } from "../../src/lib/evaluation-cli.mjs";

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("Codex evaluation is deterministic, structured, ephemeral, and read-only", () => {
  const { args } = evaluationInvocation({ cliId: "codex", prompt: "PROMPT", schemaPath: "/tmp/schema.json" });
  assert.deepEqual(args.slice(0, 2), ["--search", "exec"]);
  assert.equal(valueAfter(args, "--sandbox"), "read-only");
  assert.equal(valueAfter(args, "--output-schema"), "/tmp/schema.json");
  assert.equal(valueAfter(args, "-c"), 'approval_policy="never"');
  for (const flag of ["--strict-config", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--json"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.ok(!args.includes("danger-full-access"));
  assert.equal(args.at(-1), "PROMPT");
});

test("Claude evaluation denies writes, shells, sub-agents, sessions, and MCP config", () => {
  const { args } = evaluationInvocation({ cliId: "claude", prompt: "PROMPT", schemaPath: "/tmp/schema.json" });
  assert.equal(valueAfter(args, "--permission-mode"), "dontAsk");
  assert.match(valueAfter(args, "--disallowedTools"), /Write/);
  assert.match(valueAfter(args, "--disallowedTools"), /Bash/);
  assert.match(valueAfter(args, "--disallowedTools"), /Task/);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--json-schema"));
});

test("evaluation runtimes without a strict adapter fail closed", () => {
  assert.throws(
    () => evaluationInvocation({ cliId: "gemini", prompt: "x", schemaPath: "/tmp/schema.json" }),
    UnsupportedEvaluationRuntimeError,
  );
});
