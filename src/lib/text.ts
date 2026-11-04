/** Collapse every run of whitespace to a single space. Used for quote checking only. */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** True when `quote` appears word for word in `text` (ignoring line breaks and spacing). */
export function isExactQuote(text: string, quote: string | null | undefined): boolean {
  if (!quote) return false;
  const q = squash(quote);
  if (q.length === 0) return false;
  return squash(text).includes(q);
}

/** Does this number (as printed, e.g. "12,000" or "0.5") appear in this quote? */
export function numberInQuote(quote: string, printed: string): boolean {
  const esc = printed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\d.,])${esc}(?![\\d]|[.,]\\d)`).test(quote);
}
