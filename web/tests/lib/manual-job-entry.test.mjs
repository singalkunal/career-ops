import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manualJobLabel, manualOffer, parseManualJobUrl } from "../../src/lib/manual-job-url.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = readFileSync(join(HERE, "..", "..", "src", "components", "manual-job-entry.tsx"), "utf8");
const PIPELINE = readFileSync(join(HERE, "..", "..", "src", "components", "pipeline-view.tsx"), "utf8");

test("manual job URL validation accepts http(s) and rejects unsafe shapes", () => {
  assert.deepEqual(parseManualJobUrl(" https://company.example/jobs/42 "), {
    ok: true,
    url: "https://company.example/jobs/42",
  });
  assert.equal(parseManualJobUrl("company.example/jobs/42").ok, false);
  assert.equal(parseManualJobUrl("javascript:alert(1)").ok, false);
  assert.equal(parseManualJobUrl("https://user:secret@company.example/jobs/42").ok, false);
});

test("manual offers preserve only the pasted URL plus an explicit manual source", () => {
  assert.deepEqual(manualOffer("https://company.example/jobs/42"), {
    url: "https://company.example/jobs/42",
    company: "",
    title: "",
    location: "",
    postedAt: "",
    ats: "manual",
    source: "manual",
  });
  assert.equal(manualJobLabel("https://jobs.example.com/team/role?id=42"), "jobs.example.com/team/role?id=42");
});

test("Pipeline always mounts both manual URL actions", () => {
  assert.match(PIPELINE, /<ManualJobEntry knownUrls=/);
  assert.match(COMPONENT, /Save to inbox/);
  assert.match(COMPONENT, /Evaluate now/);
  assert.match(COMPONENT, /fetch\("\/api\/explore\/add"/);
  assert.match(COMPONENT, /kind:\s*"evaluate"/);
  assert.match(COMPONENT, /Saving is free\./);
});
