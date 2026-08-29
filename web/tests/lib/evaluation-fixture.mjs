import * as yaml from "js-yaml";

export function evaluationMachine(overrides = {}) {
  return {
    company: "Acme Systems",
    role: "AI Platform Engineer",
    score: 4.2,
    legitimacy_tier: "High Confidence",
    archetype: "AI Platform / LLMOps Engineer",
    final_decision: "Apply",
    hard_stops: [],
    soft_gaps: ["Limited direct Kubernetes ownership"],
    top_strengths: ["Production AI evaluation systems"],
    risk_level: "Low",
    confidence: "High",
    next_action: "Tailor the CV to the platform reliability requirements",
    work_auth: "not_needed",
    discard_reasons: [],
    via: null,
    company_confidential: false,
    advertised_comp: "$180,000-$220,000",
    reports_to: "VP of Engineering",
    risk_summary: {
      legitimacy: "high_confidence",
      classification: "clear",
      culture: "pass",
      interview_redflags: "not_evaluated",
      ai_infra: "consistent",
      ai_screening_disclosure: "no_match",
    },
    ...overrides,
  };
}

export function evaluationReport(machine = evaluationMachine()) {
  const summary = yaml.dump(machine, { noRefs: true, lineWidth: -1 }).trim();
  return `# Evaluation: ${machine.company} — ${machine.role}

**Date:** 2026-08-27
**URL:** https://example.com/jobs/ai-platform
**Via:** —
**Archetype:** ${machine.archetype}
**Score:** ${machine.score}/5
**Legitimacy:** ${machine.legitimacy_tier}
**Work Auth:** ➖ Not needed
**PDF:** pending

---

## Machine Summary

\`\`\`yaml
${summary}
\`\`\`

## A) Role Summary

Acme seeks a senior engineer to own evaluation and reliability for its AI platform. The role fits the candidate's production systems work.

## B) Match with CV

The candidate has direct evidence in AI evaluation, observability, agent tooling, and enterprise delivery. Kubernetes depth is a manageable gap.

## C) Level and Strategy

Position the candidate as a hands-on senior builder who can own platform outcomes without inflating management scope.

## D) Comp and Demand

The advertised range is competitive. Confirm the base, bonus, and equity split with the recruiter before relying on total compensation.

## E) Personalization Plan

Lead with production evaluation, agent reliability, and customer-facing delivery. Reorder projects to put platform work first.

## F) Interview Plan

Use the evaluation platform and enterprise delivery stories. Prepare one detailed reliability incident and one cross-functional decision.

## G) Posting Legitimacy

The employer site, role details, and compensation range are consistent. Exact apply-button freshness remains unconfirmed in headless mode.

## Risk Summary

| Signal | Status |
|---|---|
| Posting legitimacy | High Confidence |
| Employment classification | clear |
| Culture screen | pass |
| Interview red flags | not evaluated |
| AI claims vs infrastructure | consistent |
| AI-screening disclosure | no jurisdiction match |

## Cover Letter Draft

I am interested in the AI Platform Engineer role because it joins production AI evaluation, platform reliability, and hands-on delivery.

## Keywords extracted

AI evaluation, observability, reliability, platform engineering, LLMOps, incident response, Kubernetes, distributed systems.
`;
}

export function evaluationResult(machineOverrides = {}) {
  const machine = evaluationMachine(machineOverrides);
  return {
    schema_version: "career-ops-evaluation/v1",
    status: "completed",
    error: null,
    report_markdown: evaluationReport(machine),
    machine_summary: machine,
    tracker: {
      status: "Evaluated",
      note: "Strong platform fit; confirm Kubernetes depth in screening",
    },
  };
}
