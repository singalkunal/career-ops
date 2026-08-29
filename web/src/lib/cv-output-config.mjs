/** Resolve the user-owned CV source and page policy for web PDF runs. */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const POSITIONINGS = ["agentic", "fde"];

function resolveTex(root, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = path.resolve(root, value.trim());
  if (path.extname(candidate).toLowerCase() !== ".tex") return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {{mode:"html"|"latex-tex", maxPages:number, strictPages:boolean, latexSources:Record<string,string|null>, error?:string}}
 */
export function readCvOutputConfig(root) {
  let profile = {};
  try {
    profile = yaml.load(fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8")) || {};
  } catch (error) {
    return {
      mode: "html",
      maxPages: 2,
      strictPages: false,
      latexSources: { agentic: null, fde: null },
      error: `Could not read config/profile.yml: ${error.message}`,
    };
  }

  const rawMax = Number(profile?.cv?.max_pages);
  const maxPages = Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 10 ? rawMax : 2;
  const strictPages = profile?.cv?.strict_pages === true;
  if (String(profile?.cv?.output_format ?? "html").trim().toLowerCase() !== "latex") {
    return { mode: "html", maxPages, strictPages, latexSources: { agentic: null, fde: null } };
  }

  const fallback = resolveTex(root, profile?.latex?.source);
  const latexSources = Object.fromEntries(
    POSITIONINGS.map((positioning) => [
      positioning,
      resolveTex(root, profile?.latex?.sources?.[positioning]) ?? fallback,
    ]),
  );
  if (!latexSources.agentic && !latexSources.fde) {
    return {
      mode: "latex-tex",
      maxPages,
      strictPages,
      latexSources,
      error: "cv.output_format is latex, but latex.source (or latex.sources) does not point to a readable .tex file.",
    };
  }
  return { mode: "latex-tex", maxPages, strictPages, latexSources };
}

/** @param {ReturnType<typeof readCvOutputConfig>} config @param {"agentic"|"fde"} positioning */
export function latexSourceFor(config, positioning) {
  return config.latexSources?.[positioning] ?? config.latexSources?.agentic ?? config.latexSources?.fde ?? null;
}
