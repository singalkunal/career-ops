#!/usr/bin/env node

/** Apply prose-only patches to a user-owned LaTeX CV and compile the tailored copy. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { buildManifest, applyPatches } from "../../lib/latex-content.mjs";
import { compileLatexFile } from "../../generate-latex.mjs";

const [sourceArg, patchesArg, texArg, pdfArg] = process.argv.slice(2);
if (!sourceArg || !patchesArg || !texArg || !pdfArg) {
  console.error("Usage: node render-user-latex.mjs <source.tex> <patches.json> <output.tex> <output.pdf>");
  process.exit(1);
}

try {
  const source = resolve(sourceArg);
  const patchesPath = resolve(patchesArg);
  const outputTex = resolve(texArg);
  const outputPdf = resolve(pdfArg);
  const tex = await readFile(source, "utf8");
  const payload = JSON.parse(await readFile(patchesPath, "utf8"));
  const manifest = buildManifest(basename(source), tex);
  if (!manifest.supported) throw new Error(manifest.error);

  const patches = Array.isArray(payload?.patches) ? payload.patches : null;
  const ids = new Set(manifest.slots.map((slot) => slot.id));
  if (!patches || patches.some((patch) => !patch || typeof patch.id !== "string"
    || typeof patch.text !== "string" || !ids.has(patch.id))) {
    throw new Error("The tailored CV referenced an unknown or invalid LaTeX content slot.");
  }

  const tailored = applyPatches(tex, patches, manifest.slots);
  await mkdir(dirname(outputTex), { recursive: true });
  await writeFile(outputTex, tailored, "utf8");
  const compiled = await compileLatexFile(outputTex, tailored, outputPdf, true);
  if (!compiled.compiled || !compiled.pdf?.path) {
    throw new Error(compiled.compileError || compiled.postCompileError || "LaTeX compilation failed.");
  }
  console.log(JSON.stringify({
    compiled: true,
    family: manifest.family,
    patched: patches.length,
    tex: outputTex,
    pdf: compiled.pdf.path,
  }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
