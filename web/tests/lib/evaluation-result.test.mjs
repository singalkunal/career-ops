import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVALUATION_SCHEMA_VERSION,
  evaluationPayloadFromEvent,
  parseEvaluationResult,
  readEvaluationSchema,
} from "../../src/lib/evaluation-result.mjs";
import { evaluationResult } from "./evaluation-fixture.mjs";

test("parseEvaluationResult accepts a complete versioned Career Ops report", () => {
  const result = evaluationResult();
  assert.deepEqual(parseEvaluationResult(JSON.stringify(result)), result);
});

test("parseEvaluationResult fails closed on malformed and extra output", () => {
  assert.throws(() => parseEvaluationResult("not json"), /not valid JSON/);
  assert.throws(() => parseEvaluationResult(JSON.stringify({ ...evaluationResult(), extra: true })), /missing or extra fields/);
  assert.throws(() => parseEvaluationResult(JSON.stringify({ ...evaluationResult(), schema_version: "career-ops-evaluation/v2" })), /unsupported/);
});

test("parseEvaluationResult rejects a machine summary that differs from the report", () => {
  const result = evaluationResult();
  result.machine_summary.score = 3.1;
  assert.throws(() => parseEvaluationResult(JSON.stringify(result)), /report score does not match|Machine Summary does not match/);
});

test("parseEvaluationResult accepts a strict failed result without artifacts", () => {
  const failed = {
    schema_version: EVALUATION_SCHEMA_VERSION,
    status: "failed",
    error: "The posting could not be retrieved",
    report_markdown: null,
    machine_summary: null,
    tracker: null,
  };
  assert.deepEqual(parseEvaluationResult(JSON.stringify(failed)), failed);
  assert.throws(
    () => parseEvaluationResult(JSON.stringify({ ...failed, report_markdown: "partial" })),
    /must not include artifacts/,
  );
});

test("evaluationPayloadFromEvent reads Codex and Claude structured finals only", () => {
  const payload = JSON.stringify(evaluationResult());
  assert.equal(evaluationPayloadFromEvent(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: payload },
  })), payload);
  assert.deepEqual(
    JSON.parse(evaluationPayloadFromEvent(JSON.stringify({ type: "result", structured_output: evaluationResult() }))),
    evaluationResult(),
  );
  assert.equal(evaluationPayloadFromEvent("not-json"), null);
});

test("structured-output enums and constants declare their JSON types", () => {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "enum") || Object.hasOwn(value, "const")) {
      assert.ok(Object.hasOwn(value, "type"), "enum/const schema node is missing type");
    }
    Object.values(value).forEach(visit);
  };
  visit(readEvaluationSchema());
});
