import { NextRequest } from "next/server";
import fs from "node:fs";
import { resolveTailoredCv } from "@/lib/apply/cv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serve the exact manifest-linked PDF for a tracked application. A pasted-URL
// company fallback is allowed only when one unambiguous PDF exists.
export async function GET(req: NextRequest) {
  const n = (req.nextUrl.searchParams.get("n") ?? "").trim();
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!n && !company) return new Response("application number or company required", { status: 400 });
  const artifact = resolveTailoredCv({ n: n || undefined, company });
  if (!artifact) return new Response("no unambiguous tailored CV found for this offer", { status: 404 });
  try {
    const buf = fs.readFileSync(artifact.path);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${artifact.filename}"`,
        "Cache-Control": "no-store",
        ...(artifact.positioning ? { "X-Career-Ops-Positioning": artifact.positioning } : {}),
      },
    });
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
