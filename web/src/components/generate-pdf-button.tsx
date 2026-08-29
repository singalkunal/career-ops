"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileDown, Loader2, FileText, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import type { CvPositioning } from "@/components/jobs/job-store";

const LABEL: Record<CvPositioning, string> = { auto: "Auto", agentic: "Agentic", fde: "FDE" };

// Fires the real career-ops `pdf` mode (worker kind "pdf") to generate an
// ATS-optimized CV tailored to THIS offer → output/cv-… + marks the tracker.
// Once a tailored CV exists (tracker PDF ✅, or a pdf worker just finished), it
// becomes a "View tailored CV" link (served by /api/cv-pdf) + a regenerate icon.
export function GeneratePdfButton({
  n,
  company,
  pdfReady,
  artifactPositioning,
}: {
  n: string;
  company: string;
  pdfReady: boolean;
  artifactPositioning?: "agentic" | "fde" | null;
}) {
  const { jobs, startJob } = useJobs();
  const [positioning, setPositioning] = useState<CvPositioning>(artifactPositioning ?? "auto");
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "pdf" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const generate = () =>
    startJob({
      title: `CV PDF · ${company}`,
      subtitle: `${LABEL[positioning]} positioning`,
      kind: "pdf",
      input: n,
      page: `/pipeline/${n}`,
      positioning,
    });

  useEffect(() => {
    if (job?.status === "done" && job.resolvedPositioning) setPositioning(job.resolvedPositioning);
  }, [job?.status, job?.resolvedPositioning]);

  const selector = (
    <label className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-border bg-surface/40 px-2.5 text-xs text-muted focus-within:border-brand/50">
      <span className="text-faint">CV</span>
      <select
        aria-label="CV positioning"
        value={positioning}
        onChange={(event) => setPositioning(event.target.value as CvPositioning)}
        disabled={job?.status === "running"}
        className="cursor-pointer bg-transparent font-medium text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="auto">Auto</option>
        <option value="agentic">Agentic</option>
        <option value="fde">FDE</option>
      </select>
    </label>
  );

  if (job?.status === "running")
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {selector}
        <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
          <Loader2 className="size-3.5 animate-spin" /> Generating {LABEL[job.positioning ?? positioning]} CV…
        </Link>
      </span>
    );

  const ready = pdfReady || job?.status === "done";
  if (ready)
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {selector}
        <a
          href={`/api/cv-pdf?n=${encodeURIComponent(n)}&company=${encodeURIComponent(company)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
        >
          <FileText className="size-3.5" /> View tailored CV
        </a>
        <button
          onClick={generate}
          title={`Regenerate with ${LABEL[positioning]} positioning`}
          className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]"
        >
          <RotateCcw className="size-3" />
        </button>
      </span>
    );

  // Point-of-action cost affordance: generating a tailored CV runs the user's
  // AI (spends tokens). Surface it right on the trigger so cost is never a
  // surprise — the community's #1 pain (mirrors Explore's token-honesty).
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {selector}
      <button
        onClick={generate}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        title={`Generate an ATS-optimized CV with ${LABEL[positioning]} positioning`}
      >
        <FileDown className="size-3.5" /> Generate tailored CV (PDF)
      </button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}
