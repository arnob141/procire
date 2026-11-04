import fs from "node:fs";
import path from "node:path";

const dir = () => path.join(process.cwd(), "data", "samples");

export function listSamples(): string[] {
  try {
    return fs.readdirSync(dir()).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  } catch {
    return [];
  }
}

export function readSample(name: string): Uint8Array | null {
  if (!listSamples().includes(name)) return null; // only names that exist in the folder
  return new Uint8Array(fs.readFileSync(path.join(dir(), name)));
}

export function readSampleRequestCsv(): string | null {
  try {
    return fs.readFileSync(path.join(process.cwd(), "data", "purchase-request.csv"), "utf8");
  } catch {
    return null;
  }
}
