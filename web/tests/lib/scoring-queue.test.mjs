import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedScoringQueue } from "../../src/lib/scoring-queue.mjs";

test("the scoring queue never grants more than two active leases", async () => {
  const queue = new BoundedScoringQueue(2);
  let active = 0;
  let maximum = 0;
  const run = async () => {
    const lease = await queue.acquire();
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    lease.release();
  };
  await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(maximum, 2);
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, limit: 2 });
});

test("a queued scoring request can be cancelled without consuming a slot", async () => {
  const queue = new BoundedScoringQueue(1);
  const first = await queue.acquire();
  const controller = new AbortController();
  const second = queue.acquire(controller.signal);
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 1, limit: 1 });
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 0, limit: 1 });
  first.release();
});
