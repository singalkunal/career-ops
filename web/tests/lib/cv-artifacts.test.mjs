import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePdfArtifacts,
  recordPdfArtifact,
  recordPdfPositioning,
  reportNumberFromFile,
  resolvePdfArtifact,
  resolveUniqueCompanyPdf,
} from "../../src/lib/cv-artifacts.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "co-cv-artifacts-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "output"), { recursive: true });
  return root;
}

function pdf(root, relativePath) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "%PDF-1.4\n");
  return file;
}

test("reportNumberFromFile normalizes padded report numbers", () => {
  assert.equal(reportNumberFromFile("/tmp/reports/018-acme-2026-08-27.md"), "18");
  assert.equal(reportNumberFromFile("/tmp/reports/not-a-report.md"), null);
});

test("recordPdfArtifact replaces a report row with its LaTeX source", () => {
  const root = fixture();
  try {
    const manifest = join(root, "data", "pdf-index.tsv");
    const pdfPath = pdf(root, "output/cv-kunal-acme.pdf");
    const texPath = join(root, "output", "cv-kunal-acme.tex");
    writeFileSync(texPath, "\\begin{document}\\end{document}");
    writeFileSync(manifest, "30\toutput/old.pdf\told.html\tletter\t2026-08-26\tagentic\n");
    assert.deepEqual(recordPdfArtifact(root, {
      reportNum: "030", pdfPath, sourcePath: texPath, format: "letter", positioning: "agentic",
    }), { ok: true });
    const parsed = parsePdfArtifacts(readFileSync(manifest, "utf8")).get("30");
    assert.equal(parsed.pdf, "output/cv-kunal-acme.pdf");
    assert.equal(parsed.html, "output/cv-kunal-acme.tex");
    assert.equal(parsed.positioning, "agentic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfArtifact binds same-company roles to their exact report", () => {
  const root = fixture();
  try {
    const fde = pdf(root, "output/cv-kunal-lemma-fde.pdf");
    pdf(root, "output/cv-kunal-lemma-agentic.pdf");
    writeFileSync(
      join(root, "data", "pdf-index.tsv"),
      "# report\tpdf\thtml\tformat\tdate\tpositioning\n" +
        "030\toutput/cv-kunal-lemma-fde.pdf\t\tletter\t2026-08-27\tfde\n" +
        "031\toutput/cv-kunal-lemma-agentic.pdf\t\tletter\t2026-08-27\tagentic\n",
    );

    const artifact = resolvePdfArtifact(root, "030");
    assert.equal(artifact.path, realpathSync(fde));
    assert.equal(artifact.reportNum, "30");
    assert.equal(artifact.positioning, "fde");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfArtifact rejects a manifest symlink that escapes the workspace", () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), "co-cv-outside-"));
  try {
    const external = pdf(outside, "private.pdf");
    symlinkSync(external, join(root, "output", "cv-acme.pdf"));
    writeFileSync(join(root, "data", "pdf-index.tsv"), "9\toutput/cv-acme.pdf\n");
    assert.equal(resolvePdfArtifact(root, "9"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("company fallback returns one match and refuses ambiguous same-company PDFs", () => {
  const root = fixture();
  try {
    const only = pdf(root, "output/cv-kunal-meta.pdf");
    assert.equal(resolveUniqueCompanyPdf(root, "Meta").path, realpathSync(only));
    pdf(root, "output/cv-kunal-meta-second.pdf");
    assert.equal(resolveUniqueCompanyPdf(root, "Meta"), null);
    pdf(root, "output/cv-kunal-metabase.pdf");
    assert.equal(resolveUniqueCompanyPdf(root, "Metabase").filename, "cv-kunal-metabase.pdf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordPdfPositioning updates only the requested report row", () => {
  const root = fixture();
  try {
    const manifest = join(root, "data", "pdf-index.tsv");
    writeFileSync(manifest, "# report\tpdf\thtml\tformat\tdate\n030\toutput/a.pdf\t\tletter\t2026-08-27\n031\toutput/b.pdf\t\ta4\t2026-08-27\n");
    assert.deepEqual(recordPdfPositioning(root, "030", "fde"), { ok: true });
    const parsed = parsePdfArtifacts(readFileSync(manifest, "utf8"));
    assert.equal(parsed.get("30").positioning, "fde");
    assert.equal(parsed.get("31").positioning, null);
    assert.match(readFileSync(manifest, "utf8").split("\n")[0], /positioning/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
