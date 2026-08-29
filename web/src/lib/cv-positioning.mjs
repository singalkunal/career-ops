/** CV positioning selected in the web UI before a tailored PDF run. */
export const REQUESTED_CV_POSITIONINGS = new Set(["auto", "agentic", "fde"]);
export const RESOLVED_CV_POSITIONINGS = new Set(["agentic", "fde"]);

/**
 * @param {unknown} value
 * @returns {"auto"|"agentic"|"fde"|null}
 */
export function normalizeRequestedPositioning(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "auto";
  const normalized = String(value).trim().toLowerCase();
  return REQUESTED_CV_POSITIONINGS.has(normalized) ? normalized : null;
}

/**
 * Turn the UI selection into a direct tailoring instruction.
 * @param {"auto"|"agentic"|"fde"} requested
 */
export function positioningInstruction(requested) {
  if (requested === "fde") {
    return "Use the Forward-Deployed positioning: lead with customer discovery, solution design, hands-on delivery, deployment, and iteration with users. Declare positioning=\"fde\" in the CV envelope.";
  }
  if (requested === "agentic") {
    return "Use the Agentic positioning: lead with production agent systems, orchestration, MCP/RAG, evals, guardrails, tracing, and cloud reliability. Declare positioning=\"agentic\" in the CV envelope.";
  }
  return "Choose the positioning from the evaluated role. Use Forward-Deployed only when customer discovery and delivery are central; otherwise use Agentic. Declare the lane you actually used as positioning=\"fde\" or positioning=\"agentic\" in the CV envelope.";
}

/**
 * Validate that the emitted CV followed an explicit UI choice.
 * @param {"auto"|"agentic"|"fde"} requested
 * @param {unknown} declared
 * @returns {{ok:true, positioning:"agentic"|"fde"}|{ok:false,error:string}}
 */
export function resolveCvPositioning(requested, declared) {
  const actual = String(declared ?? "").trim().toLowerCase();
  if (!RESOLVED_CV_POSITIONINGS.has(actual)) {
    return { ok: false, error: "The tailored CV did not declare a valid Agentic or FDE positioning." };
  }
  if (requested !== "auto" && actual !== requested) {
    return { ok: false, error: `The tailored CV declared ${actual}, but the requested positioning was ${requested}.` };
  }
  return { ok: true, positioning: actual };
}
