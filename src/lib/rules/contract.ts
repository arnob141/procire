import type { Evidence, Finding, QuoteFields, RuleResult, Uncertainty } from "../types";
import { D, fmt, parseNumber, sameMoney } from "../money";
import { ruleDef } from "./catalog";
import { mentionsPenalty, splitClauses } from "../extract/regex";

export interface ContractOutput {
  rules: RuleResult[];
  uncertainties: Uncertainty[];
}

const mk = (id: string): RuleResult => ({
  ruleId: id, severity: ruleDef(id).severity, label: ruleDef(id).label, status: "pass", findings: [],
});

/**
 * Step: check the contract terms against the company rules.
 * A rule that cannot be tested is marked "unknown" and sent to a person. It is never passed by default.
 */
export function checkContract(fields: QuoteFields, rawText: string, earlier: Uncertainty[]): ContractOutput {
  const rules = Object.fromEntries(
    ["R2", "R3", "R4", "R5", "C3", "C4", "C5", "C6", "C7", "N1"].map((id) => [id, mk(id)]),
  ) as Record<string, RuleResult>;
  const uncertainties: Uncertainty[] = [];

  const unknown = (id: string, why: string) => {
    const r = rules[id];
    if (r.status === "pass") r.status = "unknown";
    r.unknownReason = r.unknownReason ? `${r.unknownReason} ${why}` : why;
  };
  const fail = (id: string, f: Omit<Finding, "ruleId" | "severity">) => {
    const r = rules[id];
    r.status = "fail";
    r.findings.push({ ruleId: id, severity: r.severity, ...f });
  };
  const wasUncertain = (word: string) => earlier.some((u) => u.field.toLowerCase().includes(word));

  // R2: advance payment
  const adv = fields.advancePercent;
  if (!adv) {
    unknown("R2", wasUncertain("advance") ? "The advance payment could not be confirmed (see the flagged reading)." : "The quotation does not state the advance payment.");
  } else {
    const pct = parseNumber(adv.value);
    if (!pct) unknown("R2", "The advance payment is not a number.");
    else if (pct.gt(20)) {
      fail("R2", {
        title: `Advance payment is ${pct.toString()}%`,
        detail: `The supplier asks for ${pct.toString()}% with the purchase order. The limit is 20%.`,
        evidence: [{ quote: adv.quote }],
      });
    }
  }

  // R3 and N1: late-delivery penalty
  const clause = fields.penaltyClause;
  if (!clause) {
    if (wasUncertain("penalty") || wasUncertain("late-delivery")) {
      unknown("R3", "A late-delivery clause may exist but could not be confirmed (see the flagged reading).");
      unknown("N1", "The penalty could not be read.");
    } else if (mentionsPenalty(rawText)) {
      unknown("R3", "The text mentions delay or penalty, but no clause could be read from it.");
      unknown("N1", "The penalty could not be read.");
    } else {
      const heads = splitClauses(rawText).map((c) => c.title);
      const hasHeading = /TERMS AND CONDITIONS/i.test(rawText);
      fail("R3", {
        title: "No late-delivery penalty clause",
        detail: "Nothing in the document mentions a penalty for late delivery.",
        evidence: [{
          quote: hasHeading ? "TERMS AND CONDITIONS" : null,
          note: `No clause about late delivery follows this heading. Clauses present: ${heads.length ? heads.join(", ") : "none"}.`,
        }],
      });
      rules.N1.status = "pass";
    }
  } else {
    const pct = parseNumber(fields.penaltyPercent?.value);
    const period = fields.penaltyPeriod?.value ?? "";
    const basis = fields.penaltyBasis?.value ?? "";
    const evid: Evidence[] = [{ quote: clause.quote }];
    if (!pct) unknown("N1", "The penalty percent could not be read.");
    else if (!/week/i.test(period)) {
      fail("N1", {
        title: "Penalty is not stated per week",
        detail: "The clause does not say the penalty applies per week of delay, so it cannot be compared with 0.5% per week.",
        evidence: evid,
      });
    } else if (!/order value/i.test(basis)) {
      fail("N1", {
        title: "Penalty does not say what the percent applies to",
        detail: `The clause gives ${pct.toString()}% per week but does not say it is a percent of order value.`,
        evidence: evid,
      });
    } else if (pct.lt("0.5")) {
      fail("N1", {
        title: `Penalty is only ${pct.toString()}% per week`,
        detail: "The company minimum is 0.5% of order value per week of delay.",
        evidence: evid,
      });
    }
  }

  // R4: TIN and BIN
  const missing: string[] = [];
  for (const [name, f, re] of [["TIN", fields.tin, /\bTIN\W{0,3}\d/i], ["BIN", fields.bin, /\bBIN\W{0,3}\d/i]] as const) {
    if (f) continue;
    if (wasUncertain(name.toLowerCase())) unknown("R4", `The ${name} could not be confirmed (see the flagged reading).`);
    else if (re.test(rawText)) unknown("R4", `A ${name} seems to be printed but could not be read.`);
    else missing.push(name);
  }
  if (missing.length) {
    const regLine = rawText.split(/\r?\n/).map((l) => l.trim()).find((l) => /registration|TIN|BIN/i.test(l)) ?? null;
    fail("R4", {
      title: `${missing.join(" and ")} missing`,
      detail: `The quotation gives no ${missing.join(" or ")}.`,
      evidence: [{ quote: regLine, note: regLine ? undefined : `No ${missing.join(" or ")} appears anywhere in the document.` }],
    });
  }

  // R5 and C4: delivery time
  const amt = parseNumber(fields.deliveryAmount?.value);
  const unit = fields.deliveryUnit?.value;
  if (!amt || !unit || !fields.deliveryAmount) {
    const why = wasUncertain("delivery") ? "The delivery time could not be confirmed (see the flagged reading)." : "The quotation does not state a delivery time.";
    unknown("R5", why);
    unknown("C4", why);
  } else {
    const days = unit === "weeks" ? amt.times(7) : amt;
    const note = unit === "weeks" ? `${amt.toString()} weeks = ${days.toString()} days` : undefined;
    if (days.gt(45)) {
      fail("R5", {
        title: `Delivery in ${days.toString()} days`,
        detail: `Promised ${days.toString()} days after the purchase order. The limit is 45 days.`,
        evidence: [{ quote: fields.deliveryAmount.quote, note }],
      });
    } else if (days.gt(30)) {
      fail("C4", {
        title: `Delivery in ${days.toString()} days`,
        detail: `Promised ${days.toString()} days after the purchase order. 31 to 45 days needs a person to check.`,
        evidence: [{ quote: fields.deliveryAmount.quote, note }],
      });
    }
  }

  // C3: payment terms (one finding per clause, even if it is both open and out of range)
  const pMin = parseNumber(fields.paymentMinDays?.value);
  const pMax = parseNumber(fields.paymentMaxDays?.value);
  const daysKnown = Boolean(pMin && pMax && fields.paymentMinDays);
  const outOfRange = daysKnown && (pMin!.lt(30) || pMax!.gt(60));
  const span = daysKnown ? (pMin!.eq(pMax!) ? `${pMin!.toString()} days` : `${pMin!.toString()} to ${pMax!.toString()} days`) : "";
  if (fields.paymentUnclear) {
    fail("C3", {
      title: outOfRange ? `Payment terms are open (${span})` : "Payment terms are open",
      detail: outOfRange
        ? `The wording leaves the payment period to be agreed later, and the stated range of ${span} is outside 30 to 60 days after delivery.`
        : "The wording leaves the payment period to be agreed later.",
      evidence: [{ quote: fields.paymentUnclear.quote }],
    });
  } else if (!daysKnown) {
    if (wasUncertain("payment")) unknown("C3", "The payment period could not be confirmed (see the flagged reading).");
    else
      fail("C3", {
        title: "No payment period stated",
        detail: "The quotation does not say how many days after delivery payment is due.",
        evidence: [{ quote: null, note: "No 'within N days' payment period appears in the payment clause." }],
      });
  } else if (outOfRange) {
    fail("C3", {
      title: `Payment due in ${span}`,
      detail: "Payment must fall within 30 to 60 days after delivery.",
      evidence: [{ quote: fields.paymentMinDays!.quote }],
    });
  }

  // C5: VAT shown separately at 15%
  if (fields.vatIncluded) {
    fail("C5", {
      title: "VAT is included in the price",
      detail: "VAT is not shown as a separate 15% line.",
      evidence: [{ quote: fields.vatIncluded.quote }],
    });
  } else if (!fields.vatRate || !fields.vatAmount) {
    if (wasUncertain("vat")) unknown("C5", "The VAT line could not be confirmed (see the flagged reading).");
    else
      fail("C5", {
        title: "VAT is not shown",
        detail: "No separate VAT line was found.",
        evidence: [{ quote: null, note: "No line starting with VAT appears in the document." }],
      });
  } else if (!parseNumber(fields.vatRate.value)?.eq(15)) {
    fail("C5", {
      title: `VAT is ${fields.vatRate.value}%, not 15%`,
      detail: "VAT must be shown separately at 15%.",
      evidence: [{ quote: fields.vatRate.quote }],
    });
  }

  // C6: do the numbers add up?
  let sumLines = D(0);
  let linesOk = fields.items.length > 0;
  for (const it of fields.items) {
    const q = parseNumber(it.value.quantity);
    const p = parseNumber(it.value.unitPrice);
    const a = parseNumber(it.value.lineAmount);
    if (!q || !p || !a) {
      linesOk = false;
      unknown("C6", "A line amount could not be read as a number.");
      continue;
    }
    sumLines = sumLines.plus(a);
    const expect = q.times(p);
    if (!sameMoney(expect, a)) {
      fail("C6", {
        title: "Line total is wrong",
        detail: `${fmt(q, 0)} x ${fmt(p)} = ${fmt(expect)}, but the quotation shows ${fmt(a)}.`,
        evidence: [{ quote: it.quote, note: `Calculated: ${fmt(q, 0)} x ${fmt(p)} = ${fmt(expect)}` }],
      });
    }
  }
  const total = parseNumber(fields.total?.value);
  if (!linesOk || !total || !fields.total) {
    if (rules.C6.status === "pass") unknown("C6", "The line items or the total could not be read, so the sums cannot be checked.");
  } else if (fields.vatIncluded) {
    if (!sameMoney(sumLines, total)) {
      fail("C6", {
        title: "Total does not match the lines",
        detail: `Lines add up to ${fmt(sumLines)} but the total shows ${fmt(total)}.`,
        evidence: [{ quote: fields.total.quote, note: `Sum of lines: ${fmt(sumLines)}` }],
      });
    }
  } else {
    const sub = parseNumber(fields.subtotal?.value);
    const vat = parseNumber(fields.vatAmount?.value);
    const rate = parseNumber(fields.vatRate?.value);
    if (!sub || !vat || !rate || !fields.subtotal || !fields.vatAmount || !fields.vatRate) {
      if (rules.C6.status === "pass") unknown("C6", "The subtotal or VAT line could not be read, so the sums cannot be checked.");
    } else {
      if (!sameMoney(sumLines, sub)) {
        fail("C6", {
          title: "Subtotal does not match the lines",
          detail: `Lines add up to ${fmt(sumLines)} but the subtotal shows ${fmt(sub)}.`,
          evidence: [{ quote: fields.subtotal.quote, note: `Sum of lines: ${fmt(sumLines)}` }],
        });
      }
      const expVat = sub.times(rate).div(100);
      if (!sameMoney(expVat, vat)) {
        fail("C6", {
          title: "VAT amount is wrong",
          detail: `${rate.toString()}% of ${fmt(sub)} is ${fmt(expVat)}, but the quotation shows ${fmt(vat)}.`,
          evidence: [{ quote: fields.vatAmount.quote, note: `Calculated: ${fmt(sub)} x ${rate.toString()}% = ${fmt(expVat)}` }],
        });
      }
      const expTotal = sub.plus(vat);
      if (!sameMoney(expTotal, total)) {
        fail("C6", {
          title: "Total is wrong",
          detail: `${fmt(sub)} + ${fmt(vat)} = ${fmt(expTotal)}, but the quotation shows ${fmt(total)}.`,
          evidence: [{ quote: fields.total.quote, note: `Calculated: ${fmt(sub)} + ${fmt(vat)} = ${fmt(expTotal)}` }],
        });
      }
    }
  }

  // C7: validity
  const val = parseNumber(fields.validityDays?.value);
  if (!val || !fields.validityDays) {
    unknown("C7", wasUncertain("validity") ? "The validity period could not be confirmed (see the flagged reading)." : "The quotation does not state how long it is valid.");
  } else if (val.lt(30)) {
    fail("C7", {
      title: `Valid for only ${val.toString()} days`,
      detail: "The quotation must be valid for at least 30 days.",
      evidence: [{ quote: fields.validityDays.quote }],
    });
  }

  for (const r of Object.values(rules)) {
    if (r.status === "unknown" && r.unknownReason) {
      uncertainties.push({ field: `rule ${r.ruleId}`, reason: r.unknownReason });
    }
  }

  return { rules: Object.values(rules), uncertainties };
}
