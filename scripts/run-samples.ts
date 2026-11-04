import fs from "node:fs";
import { runPipeline } from "../src/lib/graph";
import { parsePurchaseRequestCsv } from "../src/lib/pr";

async function main() {
  const request = parsePurchaseRequestCsv(fs.readFileSync("data/purchase-request.csv", "utf8"));
  const expected = JSON.parse(fs.readFileSync("tests/expected.json", "utf8"));
  let bad = 0;
  for (const f of fs.readdirSync("data/samples").sort()) {
    const r = await runPipeline({ filename: f, pdf: new Uint8Array(fs.readFileSync(`data/samples/${f}`)), request });
    const ids = [...new Set(r.findings.map((x) => x.ruleId))].sort();
    const exp = expected[f];
    const ok = r.decision === exp.decision && JSON.stringify(ids) === JSON.stringify([...exp.rules].sort());
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${f} ${r.fields?.supplierName?.value} -> ${r.decision} [${ids.join(",")}] unc=${r.uncertainties.length}`);
    if (!ok) console.log("   expected", exp.decision, exp.rules, "\n   reasons", r.reasons, "\n   unc", r.uncertainties);
  }
  console.log(bad ? `${bad} failed` : "all passed");
  process.exit(bad ? 1 : 0);
}
main();
