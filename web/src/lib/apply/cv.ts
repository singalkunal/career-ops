import { careerOpsRoot, findReportFile } from "@/lib/career-ops";
import { reportNumberFromFile, resolvePdfArtifact, resolveUniqueCompanyPdf } from "@/lib/cv-artifacts.mjs";

/**
 * Resolve a tracked application's exact manifest-linked CV. Pasted URLs with no
 * tracker identity use a company fallback only when exactly one PDF matches.
 */
export function resolveTailoredCv({ n, company }: { n?: string; company?: string }) {
  const root = careerOpsRoot();
  if ((n ?? "").trim()) {
    const reportFile = findReportFile(n!);
    const reportNum = reportFile ? reportNumberFromFile(reportFile) : null;
    return reportNum ? resolvePdfArtifact(root, reportNum) : null;
  }
  return resolveUniqueCompanyPdf(root, company ?? "");
}

/**
 * Best-effort company name from an application form/page title. ATS titles look
 * like "Role - Region @ Company" (Ashby) or "Company — Role" / "Role at Company".
 * Used as a fallback when the apply flow was started by pasting a URL (no offer
 * context) rather than from a report's Apply button.
 */
export function companyFromTitle(title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return "";
  const at = t.match(/@\s*([^|@]+?)\s*$/);
  if (at) return at[1].trim();
  const atWord = t.match(/\bat\s+([A-Z][\w&.\- ]+?)\s*$/);
  if (atWord) return atWord[1].trim();
  return "";
}
