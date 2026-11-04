import type { LineItem, QuoteFields, Sourced } from "../types";
import { squash } from "../text";

/**
 * The fixed reader. It never calls an AI. It reads the quotation layout with
 * patterns and returns only what it can point to in the text.
 */

const s = <T,>(value: T, quote: string): Sourced<T> => ({ value, quote, source: "regex" });

interface Clause {
  title: string;
  text: string; // exact clause text with line breaks squashed to spaces
}

export function emptyFields(): QuoteFields {
  return {
    supplierName: null, quotationNo: null, quoteDate: null, prReference: null,
    tin: null, bin: null, items: [], subtotal: null, vatRate: null, vatAmount: null,
    total: null, vatIncluded: null, advancePercent: null, paymentMinDays: null,
    paymentMaxDays: null, paymentUnclear: null, deliveryAmount: null, deliveryUnit: null,
    penaltyPercent: null, penaltyPeriod: null, penaltyBasis: null, penaltyClause: null,
    validityDays: null,
  };
}

/** Split the terms into numbered clauses, joining lines that wrap. */
export function splitClauses(text: string): Clause[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^terms and conditions/i.test(l.trim()));
  if (start < 0) return [];
  const clauses: Clause[] = [];
  let cur: { title: string; parts: string[] } | null = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\d+\.\s+([A-Za-z][A-Za-z ]*?)\.\s/);
    if (m) {
      if (cur) clauses.push({ title: cur.title, text: squash(cur.parts.join(" ")) });
      cur = { title: m[1], parts: [line] };
    } else if (/^(For\s|Authorised)/.test(line)) {
      break;
    } else if (cur) {
      cur.parts.push(line);
    }
  }
  if (cur) clauses.push({ title: cur.title, text: squash(cur.parts.join(" ")) });
  return clauses;
}

const lineWith = (text: string, re: RegExp): string | null => {
  for (const l of text.split(/\r?\n/)) if (re.test(l)) return l.trim();
  return null;
};

export function mentionsPenalty(text: string): boolean {
  return /penalt|late delivery|delay/i.test(text);
}

export function extractWithRules(text: string): QuoteFields {
  const f = emptyFields();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines[0]) f.supplierName = s(lines[0], lines[0]);

  const qLine = lineWith(text, /Quotation no\.?/i);
  if (qLine) {
    const m = qLine.match(/Quotation no\.?\s+(\S+)(?:\s+Date\s+(\d{4}-\d{2}-\d{2}))?/i);
    if (m) {
      f.quotationNo = s(m[1], qLine);
      if (m[2]) f.quoteDate = s(m[2], qLine);
    }
  }
  const refLine = lineWith(text, /\bReference\b/);
  if (refLine) {
    const m = refLine.match(/Reference\s+(\S+)/);
    if (m) f.prReference = s(m[1], refLine);
  }

  // Take the whole token after the label. If it has stray letters it is not accepted,
  // so a half-read number can never pass as a real TIN or BIN.
  const tin = text.match(/TIN:\s*(\S+)/);
  if (tin && /^\d+$/.test(tin[1])) f.tin = s(tin[1], tin[0]);
  const bin = text.match(/BIN:\s*(\S+)/);
  if (bin && /^\d[\d-]*\d$/.test(bin[1])) f.bin = s(bin[1], bin[0]);

  const rowRe = /^([A-Z])\s+(.+?)\s+([\d,]+)\s+([A-Za-z]+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;
  for (const l of lines) {
    const m = l.match(rowRe);
    if (m) {
      const item: LineItem = {
        code: m[1], description: m[2], quantity: m[3], unit: m[4],
        unitPrice: m[5], lineAmount: m[6], quote: l,
      };
      f.items.push(s(item, l));
    }
  }

  for (const l of lines) {
    let m = l.match(/^Subtotal\s+([\d,]+\.\d{2})$/i);
    if (m) f.subtotal = s(m[1], l);
    m = l.match(/^VAT\s+(\d+(?:\.\d+)?)\s*%\s+([\d,]+\.\d{2})$/i);
    if (m) {
      f.vatRate = s(m[1], l);
      f.vatAmount = s(m[2], l);
    }
    m = l.match(/^Total\b.*?([\d,]+\.\d{2})$/i);
    if (m) f.total = s(m[1], l);
  }

  const incl = lineWith(text, /VAT included|all taxes included|inclusive of (VAT|all taxes)/i);
  if (incl) f.vatIncluded = s(true, incl);

  const clauses = splitClauses(text);
  const byTitle = (re: RegExp) => clauses.find((c) => re.test(c.title));

  const pay = byTitle(/^payment$/i);
  if (pay) {
    if (/no advance/i.test(pay.text)) f.advancePercent = s("0", pay.text);
    else {
      const a = pay.text.match(/(\d+(?:\.\d+)?)\s*%\s*advance/i);
      if (a) f.advancePercent = s(a[1], pay.text);
    }
    const d = pay.text.match(/within\s+(\d+)(?:\s*(?:to|-)\s*(\d+))?\s+days/i);
    if (d) {
      f.paymentMinDays = s(d[1], pay.text);
      f.paymentMaxDays = s(d[2] ?? d[1], pay.text);
    }
    if (/as agreed|to be agreed|negotiable|mutually agreed/i.test(pay.text)) f.paymentUnclear = s(true, pay.text);
  }

  const del = byTitle(/^delivery$/i);
  if (del) {
    const d = del.text.match(/within\s+(\d+)\s+(days?|weeks?)/i);
    if (d) {
      f.deliveryAmount = s(d[1], del.text);
      f.deliveryUnit = s(d[2].toLowerCase().startsWith("week") ? "weeks" : "days", del.text);
    }
  }

  const pen = byTitle(/^delay$/i) ?? clauses.find((c) => /penalt/i.test(c.text) && !/^delivery$/i.test(c.title));
  if (pen) {
    f.penaltyClause = s(pen.text, pen.text);
    const p = pen.text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (p) f.penaltyPercent = s(p[1], pen.text);
    const per = pen.text.match(/(per\s+(?:full\s+)?(?:week|day|month)|for\s+each\s+(?:full\s+)?(?:week|day|month)|each\s+(?:full\s+)?(?:week|day|month))/i);
    if (per) f.penaltyPeriod = s(per[1], pen.text);
    const b = pen.text.match(/of\s+(?:the\s+)?(?:total\s+)?order\s+value/i);
    if (b) f.penaltyBasis = s(b[0], pen.text);
  }

  const val = byTitle(/^validity$/i);
  if (val) {
    const v = val.text.match(/valid\s+for\s+(\d+)\s+days/i);
    if (v) f.validityDays = s(v[1], val.text);
  }

  return f;
}
