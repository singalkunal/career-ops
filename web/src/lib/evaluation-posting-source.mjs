const MIN_DESCRIPTION_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 150_000;
const ASHBY_HOST = "jobs.ashbyhq.com";
const ASHBY_API_HOST = "api.ashbyhq.com";
const SAFE_PATH_PART = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

/** @typedef {{jobUrl?: string, title?: string, location?: string, descriptionPlain?: string, compensation?: object, compensationTierSummary?: string}} AshbyJob */
/** @typedef {{jobs?: AshbyJob[]}} AshbyBoardResponse */
/** @typedef {{companyHint?: string, fetchImpl?: typeof fetch, signal?: AbortSignal, sleep?: (milliseconds: number) => Promise<void>, timeoutMs?: number, attempts?: number}} ResolveOptions */

class AshbyHttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.retryable = status === 429 || status >= 500;
  }
}

function cleanError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {AshbyJob} job */
function formatCompensation(job) {
  if (typeof job.compensationTierSummary === "string" && job.compensationTierSummary.trim()) {
    return job.compensationTierSummary.trim();
  }
  const value = job.compensation;
  if (!value || typeof value !== "object") return "";
  const nestedSummary = "compensationTierSummary" in value ? value.compensationTierSummary : null;
  if (typeof nestedSummary === "string" && nestedSummary.trim()) return nestedSummary.trim();
  const compact = JSON.stringify(value);
  return compact === "{}" ? "" : compact.slice(0, 1_000);
}

/** Fetch one public Ashby board from its fixed official API endpoint. */
async function fetchAshbyBoard(slug, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime");
  const attempts = Math.max(1, Math.min(4, options.attempts ?? 3));
  const timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 30_000));
  const sleep = options.sleep || delay;
  const apiUrl = `https://${ASHBY_API_HOST}/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  let lastError = new Error("Ashby posting retrieval failed");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error("Ashby posting retrieval aborted");
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromRequest, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Ashby request timed out")), timeoutMs);
    try {
      const response = await fetchImpl(apiUrl, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new AshbyHttpError(response.status, response.statusText);
      /** @type {AshbyBoardResponse} */
      const payload = await response.json();
      if (!Array.isArray(payload.jobs)) throw new Error("Ashby returned an invalid job-board response");
      return payload.jobs;
    } catch (error) {
      if (options.signal?.aborted) throw new Error("Ashby posting retrieval aborted");
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError instanceof AshbyHttpError && !lastError.retryable) throw lastError;
      if (attempt === attempts) throw lastError;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromRequest);
    }
    await sleep(250 * (2 ** (attempt - 1)));
  }
  throw lastError;
}

/** Parse one exact public Ashby posting URL without accepting lookalike hosts. */
export function parseAshbyPostingUrl(input) {
  if (typeof input !== "string") return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== ASHBY_HOST || url.username || url.password) return null;
  const [slug, postingId] = url.pathname.split("/").filter(Boolean);
  if (!SAFE_PATH_PART.test(slug || "") || !SAFE_PATH_PART.test(postingId || "")) return null;
  return { slug, postingId };
}

/**
 * Resolve a scoring URL through the official ATS before the evaluator runs.
 * Unsupported URLs deliberately fall back to the evaluator's read-only web path.
 * @param {string} input
 * @param {ResolveOptions} [options]
 */
export async function resolveEvaluationPosting(input, options = {}) {
  const parsed = parseAshbyPostingUrl(input);
  if (!parsed) return { status: "unsupported" };

  const company = typeof options.companyHint === "string" && options.companyHint.trim()
    ? options.companyHint.trim()
    : parsed.slug;

  try {
    const jobs = await fetchAshbyBoard(parsed.slug, options);
    const job = jobs.find((candidate) => {
      const candidateUrl = parseAshbyPostingUrl(candidate?.jobUrl);
      return candidateUrl?.slug === parsed.slug && candidateUrl?.postingId === parsed.postingId;
    });
    if (!job) {
      return {
        status: "unavailable",
        source: "ashby-posting-api",
        error: `Ashby returned no live posting with job ID ${parsed.postingId}`,
      };
    }

    const description = typeof job.descriptionPlain === "string" ? job.descriptionPlain.trim() : "";
    if (description.length < MIN_DESCRIPTION_CHARS) {
      return {
        status: "unavailable",
        source: "ashby-posting-api",
        error: `Ashby returned the exact posting but its description was too short (${description.length} characters)`,
      };
    }

    return {
      status: "resolved",
      source: "ashby-posting-api",
      canonicalUrl: job.jobUrl || input,
      company,
      title: job.title || "",
      location: job.location || "",
      compensation: formatCompensation(job),
      description: description.slice(0, MAX_DESCRIPTION_CHARS),
    };
  } catch (error) {
    return {
      status: "unavailable",
      source: "ashby-posting-api",
      error: cleanError(error) || "Ashby posting retrieval failed",
    };
  }
}
