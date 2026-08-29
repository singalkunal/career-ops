import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCvOutputConfig, latexSourceFor } from "../../src/lib/cv-output-config.mjs";

function root() {
  const dir = mkdtempSync(join(tmpdir(), "co-cv-output-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  return dir;
}

test("readCvOutputConfig resolves user-owned LaTeX sources and a strict page budget", () => {
  const dir = root();
  try {
    writeFileSync(join(dir, "agent.tex"), "\\begin{document}agent\\end{document}");
    writeFileSync(join(dir, "fde.tex"), "\\begin{document}fde\\end{document}");
    writeFileSync(join(dir, "config", "profile.yml"), [
      "cv:", "  output_format: latex", "  max_pages: 1", "  strict_pages: true",
      "latex:", "  source: agent.tex", "  sources:", "    fde: fde.tex", "",
    ].join("\n"));
    const config = readCvOutputConfig(dir);
    assert.equal(config.mode, "latex-tex");
    assert.equal(config.maxPages, 1);
    assert.equal(config.strictPages, true);
    assert.equal(latexSourceFor(config, "agentic"), join(dir, "agent.tex"));
    assert.equal(latexSourceFor(config, "fde"), join(dir, "fde.tex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCvOutputConfig keeps HTML as the backward-compatible default", () => {
  const dir = root();
  try {
    writeFileSync(join(dir, "config", "profile.yml"), "cv:\n  output_format: html\n");
    assert.deepEqual(readCvOutputConfig(dir), {
      mode: "html", maxPages: 2, strictPages: false, latexSources: { agentic: null, fde: null },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
