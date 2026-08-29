/** Pure helpers for URLs pasted by the user instead of found by a scanner. */

/**
 * Accept one ordinary public job URL. Credentials embedded in a URL are
 * refused so an accidental secret never reaches the inbox or an AI worker.
 * @param {unknown} raw
 * @returns {{ok:true,url:string}|{ok:false,error:string}}
 */
export function parseManualJobUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, error: "Paste a job-posting URL first." };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "Paste a full job-posting URL, including https://." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "The job URL must start with http:// or https://." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Remove the username or password embedded in this URL before adding it." };
  }
  return { ok: true, url: url.toString() };
}

/** Shape accepted by the existing canonical pipeline-writer endpoint. */
export function manualOffer(url) {
  return {
    url,
    company: "",
    title: "",
    location: "",
    postedAt: "",
    ats: "manual",
    source: "manual",
  };
}

/** Honest display fallback until evaluation resolves company and role details. */
export function manualJobLabel(raw) {
  try {
    const url = new URL(String(raw ?? ""));
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  } catch {
    return "Pending evaluation";
  }
}
