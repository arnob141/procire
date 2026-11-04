import Groq from "groq-sdk";
import type { LineItem, QuoteFields, Sourced } from "../types";
import { emptyFields } from "./regex";

/** Anything that sends a system + user message and returns the reply text. Easy to fake in tests. */
export type Completer = (system: string, user: string) => Promise<string>;

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

export function aiEnabled(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}
export function aiModel(): string {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

const SYSTEM = `You read one supplier quotation and copy facts out of it. You do not decide anything.

Rules:
- Return one JSON object and nothing else.
- Every fact needs a "quote": text copied EXACTLY, character for character, from the document. Never fix spelling, never join lines, never summarise.
- A number in "value" must appear in its "quote".
- If a fact is not in the document, use null for the value and the quote. Never guess. Never calculate.
- Copy numbers as printed (keep commas and decimals).

JSON shape:
{
 "supplier_name": {"value": str|null, "quote": str|null},
 "quotation_no": {"value": str|null, "quote": str|null},
 "quote_date": {"value": str|null, "quote": str|null},
 "pr_reference": {"value": str|null, "quote": str|null},
 "tin": {"value": str|null, "quote": str|null},
 "bin": {"value": str|null, "quote": str|null},
 "items": [{"code": str|null, "description": str, "quantity": str, "unit": str, "unit_price": str, "line_amount": str, "quote": "the whole table row"}],
 "subtotal": {"value": str|null, "quote": str|null},
 "vat": {"rate": str|null, "amount": str|null, "quote": str|null},
 "total": {"value": str|null, "quote": str|null},
 "vat_included": {"value": true|false|null, "quote": str|null},
 "advance": {"percent": str|null, "quote": str|null},
 "payment": {"min_days": str|null, "max_days": str|null, "unclear": true|false|null, "quote": str|null},
 "delivery": {"amount": str|null, "unit": "days"|"weeks"|null, "quote": str|null},
 "penalty": {"percent": str|null, "period": str|null, "basis": str|null, "quote": str|null},
 "validity": {"days": str|null, "quote": str|null}
}

Notes:
- "advance.percent": the percent paid with the purchase order. Use "0" only if the document says no advance.
- "payment.min_days"/"max_days": days after delivery. "30 to 90 days" gives min "30", max "90". Set "unclear" true if the wording leaves terms open (for example "as agreed").
- "delivery": the promised time after the purchase order, as printed ("4" and "weeks").
- "penalty.period" and "penalty.basis" are short phrases copied from the clause, for example "per week" and "of order value". Use null for basis if the clause does not say what the percent applies to.
- "penalty" is null if the document has no late-delivery penalty clause.
- "vat_included": true only if the document says the prices already include VAT.`;

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" || t.toLowerCase() === "null" ? null : t;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function sourced<T>(value: T | null, quote: string | null): Sourced<T> | null {
  if (value === null || quote === null) return null;
  return { value, quote, source: "llm" };
}

/** Turn the AI's JSON into QuoteFields. No checking here; the verify step does that. */
export function llmJsonToFields(raw: unknown): QuoteFields {
  const j = obj(raw);
  const f = emptyFields();
  const simple = (k: string) => {
    const o = obj(j[k]);
    return sourced(str(o.value), str(o.quote));
  };
  f.supplierName = simple("supplier_name");
  f.quotationNo = simple("quotation_no");
  f.quoteDate = simple("quote_date");
  f.prReference = simple("pr_reference");
  f.tin = simple("tin");
  f.bin = simple("bin");
  f.subtotal = simple("subtotal");
  f.total = simple("total");

  const vat = obj(j.vat);
  f.vatRate = sourced(str(vat.rate), str(vat.quote));
  f.vatAmount = sourced(str(vat.amount), str(vat.quote));

  const vi = obj(j.vat_included);
  f.vatIncluded = sourced(bool(vi.value) === true ? true : null, str(vi.quote));

  const adv = obj(j.advance);
  f.advancePercent = sourced(str(adv.percent), str(adv.quote));

  const pay = obj(j.payment);
  const pq = str(pay.quote);
  const pmin = str(pay.min_days);
  const pmax = str(pay.max_days) ?? pmin;
  f.paymentMinDays = sourced(pmin, pq);
  f.paymentMaxDays = sourced(pmax, pq);
  f.paymentUnclear = sourced(bool(pay.unclear) === true ? true : null, pq);

  const del = obj(j.delivery);
  const unit = str(del.unit)?.toLowerCase();
  f.deliveryAmount = sourced(str(del.amount), str(del.quote));
  f.deliveryUnit = sourced(unit ? (unit.startsWith("week") ? "weeks" : "days") : null, str(del.quote));

  const pen = obj(j.penalty);
  const penQ = str(pen.quote);
  f.penaltyPercent = sourced(str(pen.percent), penQ);
  f.penaltyPeriod = sourced(str(pen.period), penQ);
  f.penaltyBasis = sourced(str(pen.basis), penQ);
  f.penaltyClause = sourced(penQ, penQ);

  const val = obj(j.validity);
  f.validityDays = sourced(str(val.days), str(val.quote));

  const items = Array.isArray(j.items) ? j.items : [];
  for (const it of items) {
    const o = obj(it);
    const quote = str(o.quote);
    const description = str(o.description);
    const quantity = str(o.quantity);
    const unitPrice = str(o.unit_price);
    const lineAmount = str(o.line_amount);
    if (!quote || !description || !quantity || !unitPrice || !lineAmount) continue;
    const item: LineItem = {
      code: str(o.code), description, unit: str(o.unit) ?? "", quantity, unitPrice, lineAmount, quote,
    };
    f.items.push({ value: item, quote, source: "llm" });
  }
  return f;
}

/** Groq call with a short wait-and-retry on rate limits (the free tier allows few tokens per minute). */
export function groqCompleter(): Completer {
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const model = aiModel();
  return async (system, user) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await client.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        return res.choices[0]?.message?.content ?? "";
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        if (status === 429 || (status !== undefined && status >= 500)) {
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };
}

export interface AiExtraction {
  fields: QuoteFields | null;
  error: string | null;
}

/** Step: read the quotation with the AI. A failure is reported, never hidden. */
export async function extractWithAI(text: string, complete: Completer): Promise<AiExtraction> {
  try {
    const reply = await complete(SYSTEM, `Document:\n"""\n${text}\n"""`);
    const cleaned = reply.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return { fields: llmJsonToFields(JSON.parse(cleaned)), error: null };
  } catch (err) {
    return { fields: null, error: err instanceof Error ? err.message : "The AI call failed." };
  }
}
