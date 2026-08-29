export const CONFIG_KEY = "career-ops:config";
export const CONFIG_CHANGED_EVENT = "career-ops:config-changed";

export function notifyConfigChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
  }
}

export function readSavedCliId() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const id = raw ? JSON.parse(raw).cliId : "";
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
export function persistCliId(cliId) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ ...prev, mode: prev.mode || "cli", cliId }),
    );
    notifyConfigChanged();
    return true;
  } catch {
    return false;
  }
}

export function pickSoleInstalled(clis) {
  const installed = (clis || []).filter((c) => c.installed);
  return installed.length === 1 ? installed[0].id : null;
}

/** Saved Config cliId, or the only installed CLI (and persist that pick). */
export async function resolveCliId() {
  const saved = readSavedCliId();
  if (saved) return saved;
  try {
    const r = await fetch("/api/clis");
    const d = await r.json();
    const sole = pickSoleInstalled(d.clis);
    if (!sole) return null;
    persistCliId(sole);
    return sole;
  } catch {
    return null;
  }
}
