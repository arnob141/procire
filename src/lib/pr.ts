import type { PurchaseRequestItem } from "./types";

/** Split one CSV line, honouring "quoted, values". */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Read purchase-request.csv. Throws a plain message if a column or number is wrong. */
export function parsePurchaseRequestCsv(csv: string): PurchaseRequestItem[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("The purchase request file has no rows.");
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string) => {
    const i = head.findIndex((h) => h.startsWith(name));
    if (i < 0) throw new Error(`The purchase request file is missing the "${name}" column.`);
    return i;
  };
  const iPr = col("pr number");
  const iItem = col("item");
  const iDesc = col("description");
  const iUnit = col("unit");
  const iQty = head.findIndex((h) => h.startsWith("quantity"));
  const iMax = head.findIndex((h) => h.startsWith("maximum unit price"));
  if (iQty < 0) throw new Error('The purchase request file is missing the "Quantity requested" column.');
  if (iMax < 0) throw new Error('The purchase request file is missing the "Maximum unit price" column.');

  return lines.slice(1).map((line, n) => {
    const c = splitCsvLine(line);
    const qty = Number(c[iQty]);
    const max = c[iMax];
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Row ${n + 2}: quantity "${c[iQty]}" is not a number.`);
    if (!/^\d+(\.\d+)?$/.test(max)) throw new Error(`Row ${n + 2}: maximum unit price "${max}" is not a number.`);
    return {
      prNumber: c[iPr],
      item: c[iItem],
      description: c[iDesc],
      unit: c[iUnit],
      quantityRequested: qty,
      maxUnitPrice: max,
    };
  });
}
