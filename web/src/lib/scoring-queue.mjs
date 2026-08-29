function queueAbortError() {
  const error = new Error("Scoring request cancelled while queued");
  error.name = "AbortError";
  return error;
}

/** A bounded FIFO queue. A lease exists only while a scorer slot is active. */
export class BoundedScoringQueue {
  constructor(limit = 2) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("queue limit must be a positive integer");
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  snapshot() {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(queueAbortError());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(queueAbortError());
      };
      if (this.active < this.limit) this.#grant(waiter);
      else {
        this.waiters.push(waiter);
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  #grant(waiter) {
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    this.active += 1;
    let released = false;
    waiter.resolve({
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.#drain();
      },
      snapshot: () => this.snapshot(),
    });
  }

  #drain() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(queueAbortError());
        continue;
      }
      this.#grant(waiter);
    }
  }
}

// Keep the queue stable across Next dev module reloads. A server restart clears
// queued requests; clients mark those interrupted and persist the failed log.
const QUEUE_KEY = Symbol.for("career-ops.scoring-queue.v1");
const globalState = globalThis;
const configuredLimit = Number(process.env.CAREER_OPS_SCORER_CONCURRENCY);
export const scoringQueue = globalState[QUEUE_KEY] ??= new BoundedScoringQueue(
  Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 2,
);
