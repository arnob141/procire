import fs from "node:fs";
import { pdfToText } from "../src/lib/pdf";
async function main() {
  const t5 = await pdfToText(new Uint8Array(fs.readFileSync("data/samples/supplier-pack-05.pdf")));
  fs.writeFileSync("tests/fixtures/pack-05.txt", t5);
  const t1 = await pdfToText(new Uint8Array(fs.readFileSync("data/samples/supplier-pack-01.pdf")));
  // TIN printed with letters inside the number: present but not readable.
  fs.writeFileSync("tests/fixtures/odd-tin.txt", t1.replace("TIN: 101458013391", "TIN: 1014-58O13391"));
  // An item that is not in the purchase request.
  fs.writeFileSync("tests/fixtures/unknown-item.txt", t1.replace("A Cotton twill fabric, 280 gsm 12,000 metre", "A Denim fabric, 340 gsm 12,000 metre"));
}
main();
