import type { ComparisonRow, Finding, PurchaseRequestItem, QuoteFields, RuleResult, Uncertainty } from "../types";
import { D, fmt, parseNumber } from "../money";
import { squash } from "../text";
import { ruleDef } from "./catalog";

const THREE = D(3);
const FIVE = D(5);

export interface CompareOutput {
  rules: RuleResult[]; // R1, C1, C2
  comparison: ComparisonRow[];
  uncertainties: Uncertainty[];
}

const norm = (s: string) => squash(s).toLowerCase();

/**
 * Step: compare the quotation with the purchase request.
 * Price and quantity are checked line by line with exact decimal maths.
 */
export function compareWithRequest(fields: QuoteFields, request: PurchaseRequestItem[]): CompareOutput {
  const r1: RuleResult = { ruleId: "R1", severity: "reject", label: ruleDef("R1").label, status: "pass", findings: [] };
  const c1: RuleResult = { ruleId: "C1", severity: "check", label: ruleDef("C1").label, status: "pass", findings: [] };
  const c2: RuleResult = { ruleId: "C2", severity: "check", label: ruleDef("C2").label, status: "pass", findings: [] };
  const uncertainties: Uncertainty[] = [];
  const comparison: ComparisonRow[] = [];

  const unknown = (r: RuleResult, why: string) => {
    if (r.status === "pass") r.status = "unknown";
    r.unknownReason = r.unknownReason ? `${r.unknownReason} ${why}` : why;
  };

  // Which purchase request does this quote belong to?
  const ref = fields.prReference?.value ?? null;
  const pool = ref ? request.filter((i) => i.prNumber === ref) : [];
  if (!ref) {
    uncertainties.push({ field: "purchase request reference", reason: "The quotation does not show which purchase request it answers." });
  } else if (pool.length === 0) {
    uncertainties.push({
      field: "purchase request reference",
      reason: `No purchase request "${ref}" has been loaded, so price and quantity cannot be compared.`,
      quote: fields.prReference?.quote,
    });
  }

  if (fields.items.length === 0) {
    uncertainties.push({ field: "line items", reason: "No item rows could be read from the quotation." });
  }

  for (const it of fields.items) {
    const row = it.value;
    const match = pool.find(
      (p) => (row.code ? p.item === row.code : true) && norm(p.description) === norm(row.description),
    );
    const qty = parseNumber(row.quantity);
    const price = parseNumber(row.unitPrice);

    if (!match) {
      const why = pool.length
        ? `Item "${row.description}" does not match any line in ${ref} (matched on item letter and description).`
        : "No purchase request lines to compare with.";
      uncertainties.push({ field: "line item match", reason: why, quote: row.quote });
      for (const r of [r1, c1, c2]) unknown(r, why);
      comparison.push({
        code: row.code, description: row.description, requestedQty: null, quotedQty: row.quantity,
        qtyDiffPercent: null, maxUnitPrice: null, quotedUnitPrice: row.unitPrice, priceOverPercent: null, quote: row.quote,
      });
      continue;
    }

    if (norm(match.unit) !== norm(row.unit)) {
      const why = `Unit "${row.unit}" in the quotation differs from "${match.unit}" in the purchase request.`;
      uncertainties.push({ field: "unit", reason: why, quote: row.quote });
      for (const r of [r1, c1, c2]) unknown(r, why);
      continue;
    }

    const max = parseNumber(match.maxUnitPrice)!;
    const requested = D(match.quantityRequested);
    const overPct = price ? price.minus(max).div(max).times(100) : null;
    const qtyPct = qty ? qty.minus(requested).div(requested).times(100) : null;

    comparison.push({
      code: row.code, description: row.description, requestedQty: match.quantityRequested, quotedQty: row.quantity,
      qtyDiffPercent: qtyPct ? qtyPct.toDecimalPlaces(2).toString() : null,
      maxUnitPrice: match.maxUnitPrice, quotedUnitPrice: row.unitPrice,
      priceOverPercent: overPct ? overPct.toDecimalPlaces(2).toString() : null, quote: row.quote,
    });

    if (!price || !overPct) {
      unknown(r1, "Unit price could not be read as a number.");
      unknown(c1, "Unit price could not be read as a number.");
    } else if (overPct.gt(THREE)) {
      const f: Finding = {
        ruleId: "R1", severity: "reject", title: `Price is ${overPct.toFixed(2)}% above the maximum`,
        detail: `Item ${row.code ?? ""} ${row.description}: quoted ${fmt(price)} BDT, maximum in ${match.prNumber} is ${fmt(max)} BDT. More than 3% over.`,
        evidence: [{ quote: row.quote, note: `Purchase request ${match.prNumber} item ${match.item}: maximum unit price ${fmt(max)} BDT.` }],
      };
      r1.status = "fail";
      r1.findings.push(f);
    } else if (overPct.gt(0)) {
      const f: Finding = {
        ruleId: "C1", severity: "check", title: `Price is ${overPct.toFixed(2)}% above the maximum`,
        detail: `Item ${row.code ?? ""} ${row.description}: quoted ${fmt(price)} BDT, maximum in ${match.prNumber} is ${fmt(max)} BDT. Over, but by no more than 3%.`,
        evidence: [{ quote: row.quote, note: `Purchase request ${match.prNumber} item ${match.item}: maximum unit price ${fmt(max)} BDT.` }],
      };
      c1.status = "fail";
      c1.findings.push(f);
    }

    if (!qty || !qtyPct) {
      unknown(c2, "Quantity could not be read as a number.");
    } else if (qtyPct.abs().gt(FIVE)) {
      const dir = qtyPct.lt(0) ? "below" : "above";
      const f: Finding = {
        ruleId: "C2", severity: "check", title: `Quantity is ${qtyPct.abs().toFixed(1)}% ${dir} the request`,
        detail: `Item ${row.code ?? ""} ${row.description}: quoted ${fmt(qty, 0)}, requested ${fmt(requested, 0)}. More than 5% different.`,
        evidence: [{ quote: row.quote, note: `Purchase request ${match.prNumber} item ${match.item}: quantity requested ${fmt(requested, 0)}.` }],
      };
      c2.status = "fail";
      c2.findings.push(f);
    }
  }

  if (fields.items.length === 0) for (const r of [r1, c1, c2]) unknown(r, "No item rows could be read.");

  return { rules: [r1, c1, c2], comparison, uncertainties };
}
