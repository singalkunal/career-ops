"use client";

import { useMemo, useState } from "react";
import { BookmarkPlus, Link2, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { CostBadge } from "@/components/cost/cost-badge";
import { useJobs } from "@/components/jobs/job-store";
import { manualOffer, parseManualJobUrl } from "@/lib/manual-job-url.mjs";
import { normalizeUrl } from "@/lib/core/url-key.mjs";

type Action = "save" | "evaluate";
type Notice = { tone: "success" | "error"; text: string } | null;

export function ManualJobEntry({ knownUrls }: { knownUrls: string[] }) {
  const router = useRouter();
  const { startJob } = useJobs();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => new Set());
  const knownKeys = useMemo(
    () => new Set([...knownUrls.map(normalizeUrl).filter(Boolean), ...savedKeys]),
    [knownUrls, savedKeys],
  );

  async function saveToInbox(jobUrl: string): Promise<"saved" | "existing"> {
    const key = normalizeUrl(jobUrl);
    if (key && knownKeys.has(key)) return "existing";

    const response = await fetch("/api/explore/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offers: [manualOffer(jobUrl)] }),
    });
    const result = (await response.json().catch(() => ({}))) as { added?: number; error?: string };
    if (!response.ok || result.error) throw new Error(result.error || "Career Ops could not save this URL.");
    if (!result.added) throw new Error("Career Ops did not add this URL to the inbox.");

    if (key) setSavedKeys((current) => new Set([...current, key]));
    router.refresh();
    window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "manual-add", input: jobUrl } }));
    return "saved";
  }

  async function run(action: Action) {
    const parsed = parseManualJobUrl(url);
    if (!parsed.ok) {
      setNotice({ tone: "error", text: parsed.error });
      return;
    }

    setBusy(action);
    setNotice(null);
    try {
      const saved = await saveToInbox(parsed.url);
      if (action === "evaluate") {
        startJob({
          title: "Evaluate · manual URL",
          subtitle: parsed.url,
          kind: "evaluate",
          input: parsed.url,
          page: "/pipeline",
        });
        setNotice({ tone: "success", text: "Evaluation started. Follow it in the Workers tray." });
      } else {
        setNotice({ tone: "success", text: saved === "existing" ? "This URL is already in your inbox." : "Saved to your inbox." });
      }
      setUrl("");
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Career Ops could not add this URL." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-border bg-surface/40 p-4 sm:p-5" aria-labelledby="manual-job-heading">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand" aria-hidden="true">
          <Link2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="manual-job-heading" className="text-sm font-semibold text-foreground">Add a job you found elsewhere</h2>
          <p id="manual-job-help" className="mt-0.5 text-xs text-muted">
            Paste the official posting URL. Save it for later, or evaluate it now against your CV.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2 lg:flex-row"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run("save");
        }}
      >
        <label htmlFor="manual-job-url" className="sr-only">Job-posting URL</label>
        <input
          id="manual-job-url"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (notice) setNotice(null);
          }}
          aria-describedby="manual-job-help manual-job-status"
          aria-invalid={notice?.tone === "error"}
          placeholder="https://company.com/jobs/role"
          className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-border bg-background/60 px-3.5 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40"
          disabled={busy !== null}
        />
        <button
          type="submit"
          disabled={busy !== null}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-foreground transition-colors hover:border-brand/40 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <BookmarkPlus className="size-4" />}
          Save to inbox
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("evaluate")}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "evaluate" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          Evaluate now
        </button>
      </form>

      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-faint">Saving is free.</span>
        <CostBadge kind="spend" size="xs" />
        <span className="text-xs text-faint">applies only to Evaluate now.</span>
        <p
          id="manual-job-status"
          role={notice?.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          className={notice ? `text-xs ${notice.tone === "error" ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}` : "sr-only"}
        >
          {notice?.text ?? "Ready to add a job URL."}
        </p>
      </div>
    </section>
  );
}
