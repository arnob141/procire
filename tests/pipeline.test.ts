import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/lib/graph";
import { parsePurchaseRequestCsv } from "../src/lib/pr";
import type { Completer } from "../src/lib/extract/llm";

const request = parsePurchaseRequestCsv(fs.readFileSync("data/purchase-request.csv", "utf8"));
const expected = JSON.parse(fs.readFileSync("tests/expected.json", "utf8")) as Record<string, { supplier: string; decision: string; rules: string[] }>;
const pdf = (n: string) => new Uint8Array(fs.readFileSync(`data/samples/${n}`));

describe("sample pack, fixed reader only", () => {
  for (const [file, exp] of Object.entries(expected)) {
    it(`${file}: ${exp.decision}`, async () => {
      const r = await runPipeline({ filename: file, pdf: pdf(file), request });
      expect(r.fields?.supplierName?.value).toBe(exp.supplier);
      expect(r.decision).toBe(exp.decision);
      expect([...new Set(r.findings.map((f) => f.ruleId))].sort()).toEqual([...exp.rules].sort());
    });
  }

  it("every piece of evidence is exact text from the document", async () => {
    for (const file of Object.keys(expected)) {
      const r = await runPipeline({ filename: file, pdf: pdf(file), request });
      const flat = r.rawText.replace(/\s+/g, " ");
      for (const f of r.findings) {
        for (const e of f.evidence) {
          if (e.quote) expect(flat).toContain(e.quote.replace(/\s+/g, " "));
        }
      }
    }
  });

  it("runs the steps in the fixed order", async () => {
    const r = await runPipeline({ filename: "supplier-pack-01.pdf", pdf: pdf("supplier-pack-01.pdf"), request });
    expect(r.trace.map((t) => t.step)).toEqual([
      "ingest", "read_rules", "read_ai", "verify", "compare", "contract", "decide", "ask_person",
    ]);
    expect(r.trace.find((t) => t.step === "ask_person")?.status).toBe("skipped");
  });

  it("a person is asked when the answer is Needs a person to check", async () => {
    const r = await runPipeline({ filename: "supplier-pack-09.pdf", pdf: pdf("supplier-pack-09.pdf"), request });
    expect(r.questions.length).toBeGreaterThan(0);
    expect(r.trace.find((t) => t.step === "ask_person")?.status).toBe("stopped");
  });
});

describe("never guess", () => {
  it("stops and asks a person when the PDF has no text", async () => {
    const r = await runPipeline({ filename: "scan.pdf", text: "   ", request });
    expect(r.decision).toBe("Needs a person to check");
    expect(r.trace.find((t) => t.step === "compare")?.status).toBe("skipped");
    expect(r.trace.find((t) => t.step === "ask_person")?.status).toBe("stopped");
  });

  it("does not reject on a missing TIN when one is printed but unreadable", async () => {
    const text = fs.readFileSync("tests/fixtures/odd-tin.txt", "utf8");
    const r = await runPipeline({ filename: "odd.pdf", text, request });
    expect(r.findings.some((f) => f.ruleId === "R4")).toBe(false);
    expect(r.decision).toBe("Needs a person to check");
  });

  it("flags an unknown item instead of assuming a price check", async () => {
    const text = fs.readFileSync("tests/fixtures/unknown-item.txt", "utf8");
    const r = await runPipeline({ filename: "x.pdf", text, request });
    expect(r.decision).toBe("Needs a person to check");
    expect(r.uncertainties.some((u) => u.field === "line item match")).toBe(true);
  });
});

describe("AI cross-check", () => {
  const text = () => {
    // Use the extracted text of pack-05 (Meghna, 40% advance).
    return fs.readFileSync("tests/fixtures/pack-05.txt", "utf8");
  };
  const aiJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      supplier_name: { value: "Meghna Carton Works", quote: "Meghna Carton Works" },
      advance: { percent: "40", quote: "1. Payment. 40% advance payable with the purchase order. 40% advance with the purchase order, balance 60% within 30 days of delivery." },
      ...over,
    });

  it("marks fields as confirmed when the AI and the fixed reader agree", async () => {
    const complete: Completer = async () => aiJson();
    const r = await runPipeline({ filename: "a.pdf", text: text(), request, complete });
    expect(r.fields?.advancePercent?.source).toBe("both");
    expect(r.decision).toBe("Reject");
    expect(r.mode.ai).toBe("groq");
  });

  it("ignores an AI quote that is not in the document", async () => {
    const complete: Completer = async () =>
      aiJson({ advance: { percent: "5", quote: "Only 5% advance is needed." } });
    const r = await runPipeline({ filename: "a.pdf", text: text(), request, complete });
    expect(r.fields?.advancePercent?.value).toBe("40"); // fixed reader's verified value stays
    expect(r.uncertainties.some((u) => u.reason.includes("not in the document"))).toBe(true);
    expect(r.decision).toBe("Reject"); // the verified 40% still rejects
  });

  it("asks a person when the AI contradicts the fixed reader with a real quote", async () => {
    const complete: Completer = async () =>
      aiJson({
        advance: {
          percent: "60",
          quote: "40% advance with the purchase order, balance 60% within 30 days of delivery.",
        },
      });
    const r = await runPipeline({ filename: "a.pdf", text: text(), request, complete });
    expect(r.fields?.advancePercent).toBeNull();
    expect(r.uncertainties.some((u) => u.field === "advance payment" && u.reason.includes("disagree"))).toBe(true);
    expect(r.decision).toBe("Needs a person to check"); // never rejects on a disputed reading
  });

  it("survives a broken AI reply by using the fixed reader and saying so", async () => {
    const complete: Completer = async () => "not json at all";
    const r = await runPipeline({ filename: "a.pdf", text: text(), request, complete });
    expect(r.decision).toBe("Reject");
    expect(r.trace.find((t) => t.step === "read_ai")?.status).toBe("skipped");
  });
});
