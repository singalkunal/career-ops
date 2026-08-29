import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAshbyPostingUrl,
  resolveEvaluationPosting,
} from "../../src/lib/evaluation-posting-source.mjs";

const URL = "https://jobs.ashbyhq.com/ditto/50646667-e435-4245-9194-588138ae886a";
const OTHER = "https://jobs.ashbyhq.com/ditto/11111111-1111-1111-1111-111111111111";

test("Ashby parsing pins HTTPS, the exact host, board slug, and posting ID", () => {
  assert.deepEqual(parseAshbyPostingUrl(`${URL}/application?x=1`), {
    slug: "ditto",
    postingId: "50646667-e435-4245-9194-588138ae886a",
  });
  for (const value of [
    "http://jobs.ashbyhq.com/ditto/id",
    "https://jobs.ashbyhq.com.evil.example/ditto/id",
    "https://user@jobs.ashbyhq.com/ditto/id",
    "https://jobs.ashbyhq.com/ditto",
    "not a url",
  ]) assert.equal(parseAshbyPostingUrl(value), null, value);
});

test("Ashby resolution selects the exact job ID and returns its official description", async () => {
  const description = "Build agent runtimes, typed tools, evaluation loops, and production observability. ".repeat(5);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), redirect: init.redirect });
    return new Response(JSON.stringify({ jobs: [
      { jobUrl: OTHER, title: "Another role", location: "Remote", descriptionPlain: "x".repeat(300) },
      {
        jobUrl: `${URL}/application`,
        title: "AI Engineer",
        location: "Remote",
        descriptionPlain: description,
        compensation: { compensationTierSummary: "$185K – $259K" },
      },
    ] }), { status: 200 });
  };

  const result = await resolveEvaluationPosting(URL, { fetchImpl, companyHint: "Ditto" });
  assert.equal(result.status, "resolved");
  assert.equal(result.title, "AI Engineer");
  assert.equal(result.company, "Ditto");
  assert.equal(result.compensation, "$185K – $259K");
  assert.equal(result.description, description.trim());
  assert.deepEqual(calls, [{
    url: "https://api.ashbyhq.com/posting-api/job-board/ditto?includeCompensation=true",
    redirect: "error",
  }]);
});

test("unsupported boards do not call Ashby and retain the web fallback", async () => {
  let called = false;
  const result = await resolveEvaluationPosting("https://boards.greenhouse.io/acme/jobs/7", {
    fetchImpl: async () => { called = true; return new Response(); },
  });
  assert.deepEqual(result, { status: "unsupported" });
  assert.equal(called, false);
});

test("an official-source failure is explicit and non-throwing", async () => {
  const result = await resolveEvaluationPosting(URL, {
    fetchImpl: async () => { throw new Error("HTTP 429 Too Many Requests\nsecret body"); },
    attempts: 1,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.source, "ashby-posting-api");
  assert.equal(result.error, "HTTP 429 Too Many Requests secret body");
});

test("a board response cannot substitute a different Ashby job", async () => {
  const result = await resolveEvaluationPosting(URL, {
    fetchImpl: async () => new Response(JSON.stringify({
      jobs: [{ jobUrl: OTHER, descriptionPlain: "x".repeat(300) }],
    }), { status: 200 }),
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /no live posting with job ID 50646667/);
});

test("retryable Ashby failures are retried before falling back", async () => {
  let calls = 0;
  const result = await resolveEvaluationPosting(URL, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 503, statusText: "Unavailable" });
      return new Response(JSON.stringify({ jobs: [{
        jobUrl: URL,
        title: "AI Engineer",
        descriptionPlain: "x".repeat(300),
      }] }), { status: 200 });
    },
    sleep: async () => {},
  });
  assert.equal(result.status, "resolved");
  assert.equal(calls, 2);
});
