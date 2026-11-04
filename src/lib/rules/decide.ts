import type { Decision, HumanQuestion, RuleResult, Uncertainty } from "../types";

export interface Decided {
  decision: Decision;
  reasons: string[];
  questions: HumanQuestion[];
}

/**
 * Step: final answer.
 * Any reject finding means Reject. Otherwise anything doubtful means a person checks.
 * Approve only when every rule was tested and none applies. Uncertainty never causes a Reject on its own.
 */
export function decide(rules: RuleResult[], uncertainties: Uncertainty[], fatal: string | null): Decided {
  if (fatal) {
    return {
      decision: "Needs a person to check",
      reasons: [fatal],
      questions: [{ question: fatal, ruleId: "-", evidence: [] }],
    };
  }

  const findings = rules.flatMap((r) => r.findings);
  const rejects = findings.filter((f) => f.severity === "reject");
  const checks = findings.filter((f) => f.severity === "check");
  const unknownRules = rules.filter((r) => r.status === "unknown");

  if (rejects.length) {
    return {
      decision: "Reject",
      reasons: rejects.map((f) => `${f.ruleId}: ${f.title}. ${f.detail}`),
      questions: [],
    };
  }

  if (checks.length || uncertainties.length || unknownRules.length) {
    const reasons = [
      ...checks.map((f) => `${f.ruleId}: ${f.title}. ${f.detail}`),
      ...uncertainties.map((u) => `Not sure about ${u.field}: ${u.reason}`),
    ];
    const questions: HumanQuestion[] = [
      ...checks.map((f) => ({
        question: `${f.title}. Is this acceptable for this purchase?`,
        ruleId: f.ruleId,
        evidence: f.evidence,
      })),
      ...uncertainties.map((u) => ({
        question: `Please confirm ${u.field}. ${u.reason}`,
        ruleId: "-",
        evidence: [{ quote: u.quote ?? null }],
      })),
    ];
    return { decision: "Needs a person to check", reasons, questions };
  }

  return {
    decision: "Approve",
    reasons: [`All ${rules.length} rule checks were run on text found in the document and none applies.`],
    questions: [],
  };
}
