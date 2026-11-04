import type { LineItem, QuoteFields, Sourced, Uncertainty } from "../types";
import { isExactQuote, numberInQuote, squash } from "../text";
import { parseNumber } from "../money";
import { emptyFields } from "./regex";

type StrKey =
  | "supplierName" | "quotationNo" | "quoteDate" | "prReference" | "tin" | "bin"
  | "subtotal" | "vatRate" | "vatAmount" | "total" | "advancePercent"
  | "paymentMinDays" | "paymentMaxDays" | "deliveryAmount" | "deliveryUnit"
  | "penaltyPercent" | "penaltyPeriod" | "penaltyBasis" | "penaltyClause" | "validityDays";
type BoolKey = "vatIncluded" | "paymentUnclear";

const STR_KEYS: StrKey[] = [
  "supplierName", "quotationNo", "quoteDate", "prReference", "tin", "bin",
  "subtotal", "vatRate", "vatAmount", "total", "advancePercent",
  "paymentMinDays", "paymentMaxDays", "deliveryAmount", "deliveryUnit",
  "penaltyPercent", "penaltyPeriod", "penaltyBasis", "penaltyClause", "validityDays",
];
const BOOL_KEYS: BoolKey[] = ["vatIncluded", "paymentUnclear"];
const NUMERIC: StrKey[] = [
  "subtotal", "vatRate", "vatAmount", "total", "advancePercent",
  "paymentMinDays", "paymentMaxDays", "deliveryAmount", "penaltyPercent", "validityDays",
];

const LABEL: Record<string, string> = {
  supplierName: "supplier name", quotationNo: "quotation number", quoteDate: "quotation date",
  prReference: "purchase request reference", tin: "TIN", bin: "BIN", subtotal: "subtotal",
  vatRate: "VAT rate", vatAmount: "VAT amount", total: "total", advancePercent: "advance payment",
  paymentMinDays: "payment days (shortest)", paymentMaxDays: "payment days (longest)",
  deliveryAmount: "delivery time", deliveryUnit: "delivery time unit", penaltyPercent: "penalty percent",
  penaltyPeriod: "penalty period", penaltyBasis: "penalty basis", penaltyClause: "late-delivery clause",
  validityDays: "validity", vatIncluded: "VAT included flag", paymentUnclear: "payment wording",
};

/** Does the claimed value really appear in the quote it points to? */
function valueSupportedByQuote(key: StrKey, value: string, quote: string): boolean {
  if (key === "advancePercent" && value === "0") return /no advance|nil advance|without advance/i.test(quote);
  if (key === "deliveryUnit") return new RegExp(value.replace(/s$/, ""), "i").test(quote);
  if (key === "penaltyClause") return squash(quote) === squash(value);
  if (NUMERIC.includes(key)) {
    // The printed number must appear in the quote. Range ends like "30 to 90" count.
    return numberInQuote(quote, value);
  }
  return squash(quote).toLowerCase().includes(squash(value).toLowerCase());
}

function sameValue(key: StrKey, a: string, b: string): boolean {
  if (NUMERIC.includes(key)) {
    const x = parseNumber(a);
    const y = parseNumber(b);
    return x !== null && y !== null && x.eq(y);
  }
  return squash(a).toLowerCase() === squash(b).toLowerCase();
}

export interface ReconcileOutput {
  fields: QuoteFields;
  uncertainties: Uncertainty[];
}

/**
 * Step: verify. Every value must have a quote that appears word for word in the
 * document. When the AI and the fixed reader disagree, the field is left empty
 * and a person is asked. Nothing is guessed.
 */
export function reconcile(text: string, rules: QuoteFields, ai: QuoteFields | null): ReconcileOutput {
  const out = emptyFields();
  const uncertainties: Uncertainty[] = [];

  const check = <T,>(key: string, c: Sourced<T> | null, who: string, valueOk: (c: Sourced<T>) => boolean): Sourced<T> | null => {
    if (!c) return null;
    if (!isExactQuote(text, c.quote)) {
      uncertainties.push({
        field: LABEL[key] ?? key,
        reason: `The ${who} gave a quote that is not in the document, so it was ignored.`,
        quote: c.quote,
      });
      return null;
    }
    if (!valueOk(c)) {
      uncertainties.push({
        field: LABEL[key] ?? key,
        reason: `The ${who} gave a value that is not in its own quote, so it was ignored.`,
        quote: c.quote,
      });
      return null;
    }
    return c;
  };

  for (const key of STR_KEYS) {
    const r = check(key, rules[key] as Sourced<string> | null, "fixed reader", (c) => valueSupportedByQuote(key, c.value, c.quote));
    const a = check(key, ai?.[key] as Sourced<string> | null | undefined ?? null, "AI", (c) => valueSupportedByQuote(key, c.value, c.quote));
    if (r && a) {
      if (sameValue(key, r.value, a.value)) out[key] = { ...r, source: "both" };
      else {
        uncertainties.push({
          field: LABEL[key],
          reason: `The AI read "${a.value}" but the fixed reader read "${r.value}". They disagree, so a person should confirm.`,
          quote: r.quote,
        });
      }
    } else out[key] = (r ?? a) as Sourced<string> | null;
  }

  for (const key of BOOL_KEYS) {
    const r = check(key, rules[key] as Sourced<boolean> | null, "fixed reader", () => true);
    const a = check(key, ai?.[key] as Sourced<boolean> | null | undefined ?? null, "AI", () => true);
    if (r && a) out[key] = r.value === a.value ? { ...r, source: "both" } : null;
    else out[key] = (r ?? a) as Sourced<boolean> | null;
    if (r && a && r.value !== a.value) {
      uncertainties.push({ field: LABEL[key], reason: "The AI and the fixed reader disagree.", quote: r.quote });
    }
  }

  // Line items: match rows by their exact quote.
  const rowOk = (c: Sourced<LineItem>, who: string): Sourced<LineItem> | null => {
    const row = c.value;
    if (!isExactQuote(text, c.quote)) {
      uncertainties.push({ field: "line item", reason: `The ${who} gave a table row that is not in the document, so it was ignored.`, quote: c.quote });
      return null;
    }
    for (const [name, v] of [["quantity", row.quantity], ["unit price", row.unitPrice], ["line amount", row.lineAmount]] as const) {
      if (!numberInQuote(c.quote, v)) {
        uncertainties.push({ field: `line item ${name}`, reason: `The ${who} gave ${name} "${v}" which is not in the row it quoted.`, quote: c.quote });
        return null;
      }
    }
    return c;
  };
  const rItems = rules.items.map((i) => rowOk(i, "fixed reader")).filter(Boolean) as Sourced<LineItem>[];
  const aItems = (ai?.items ?? []).map((i) => rowOk(i, "AI")).filter(Boolean) as Sourced<LineItem>[];
  const used = new Set<number>();
  for (const r of rItems) {
    const j = aItems.findIndex((a, idx) => !used.has(idx) && squash(a.quote) === squash(r.quote));
    if (j < 0) {
      out.items.push(r);
      continue;
    }
    used.add(j);
    const a = aItems[j].value;
    const same = ([["quantity", r.value.quantity, a.quantity], ["unit price", r.value.unitPrice, a.unitPrice], ["line amount", r.value.lineAmount, a.lineAmount]] as const)
      .every(([, x, y]) => parseNumber(x)?.eq(parseNumber(y) ?? NaN) ?? false);
    if (same) out.items.push({ ...r, source: "both" });
    else uncertainties.push({ field: "line item", reason: "The AI and the fixed reader read different numbers from this row.", quote: r.quote });
  }
  aItems.forEach((a, idx) => { if (!used.has(idx)) out.items.push(a); });

  return { fields: out, uncertainties };
}
