import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeRequestedPositioning,
  positioningInstruction,
  resolveCvPositioning,
} from "../../src/lib/cv-positioning.mjs";

test("normalizeRequestedPositioning defaults to auto and rejects unknown values", () => {
  assert.equal(normalizeRequestedPositioning(undefined), "auto");
  assert.equal(normalizeRequestedPositioning(" FDE "), "fde");
  assert.equal(normalizeRequestedPositioning("general"), null);
});

test("positioningInstruction makes each lane operational", () => {
  assert.match(positioningInstruction("auto"), /choose the positioning/i);
  assert.match(positioningInstruction("agentic"), /MCP\/RAG/i);
  assert.match(positioningInstruction("fde"), /customer discovery/i);
});

test("resolveCvPositioning accepts auto choice and enforces explicit choice", () => {
  assert.deepEqual(resolveCvPositioning("auto", "fde"), { ok: true, positioning: "fde" });
  assert.deepEqual(resolveCvPositioning("agentic", "agentic"), { ok: true, positioning: "agentic" });
  assert.equal(resolveCvPositioning("fde", "agentic").ok, false);
  assert.equal(resolveCvPositioning("auto", "unknown").ok, false);
});
