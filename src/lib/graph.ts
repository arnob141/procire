import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  AnalysisResult, ComparisonRow, HumanQuestion, PurchaseRequestItem, QuoteFields,
  RuleResult, TraceStep, Uncertainty, Decision,
} from "./types";
import { pdfToText } from "./pdf";
import { extractWithRules } from "./extract/regex";
import { aiModel, extractWithAI, type Completer } from "./extract/llm";
import { reconcile } from "./extract/reconcile";
import { compareWithRequest } from "./rules/compare";
import { checkContract } from "./rules/contract";
import { decide } from "./rules/decide";

/**
 * The fixed pipeline. Eight steps, always in this order. No step chooses what runs next;
 * the only branches are two plain if-statements written below (stop early if the PDF
 * cannot be read, and ask a person if the answer is not a clear Approve or Reject).
 */
export const STEPS = [
  { id: "ingest", label: "Read the PDF" },
  { id: "read_rules", label: "Read the layout with fixed patterns" },
  { id: "read_ai", label: "Read the quotation with the AI" },
  { id: "verify", label: "Check every quote against the document" },
  { id: "compare", label: "Compare with the purchase request" },
  { id: "contract", label: "Check the contract rules" },
  { id: "decide", label: "Give the final answer" },
  { id: "ask_person", label: "Ask a person" },
] as const;

const concat = <T,>() => ({ reducer: (a: T[], b: T[]) => a.concat(b), default: () => [] as T[] });

const State = Annotation.Root({
  filename: Annotation<string>(),
  pdf: Annotation<Uint8Array | null>(),
  rawText: Annotation<string>(),
  request: Annotation<PurchaseRequestItem[]>(),
  fatal: Annotation<string | null>(),
  rulesFields: Annotation<QuoteFields | null>(),
  aiFields: Annotation<QuoteFields | null>(),
  fields: Annotation<QuoteFields | null>(),
  comparison: Annotation<ComparisonRow[]>(),
  ruleResults: Annotation<RuleResult[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  uncertainties: Annotation<Uncertainty[]>(concat<Uncertainty>()),
  decision: Annotation<Decision | null>(),
  reasons: Annotation<string[]>(),
  questions: Annotation<HumanQuestion[]>(),
  trace: Annotation<TraceStep[]>(concat<TraceStep>()),
});
type S = typeof State.State;

const completerOf = (config?: RunnableConfig) =>
  (config?.configurable?.complete as Completer | null | undefined) ?? null;

/** Wrap a step so it is timed and leaves a line in the trace. */
function step(
  id: (typeof STEPS)[number]["id"],
  run: (s: S, config?: RunnableConfig) => Promise<{ update: Partial<S>; summary: string; status?: TraceStep["status"] }> | { update: Partial<S>; summary: string; status?: TraceStep["status"] },
) {
  return async (s: S, config?: RunnableConfig): Promise<Partial<S>> => {
    const t0 = Date.now();
    const { update, summary, status } = await run(s, config);
    const label = STEPS.find((x) => x.id === id)!.label;
    return { ...update, trace: [{ step: id, label, status: status ?? "done", summary, ms: Date.now() - t0 }] };
  };
}

const ingest = step("ingest", async (s) => {
  let text = s.rawText ?? "";
  if (!text && s.pdf) {
    try {
      text = await pdfToText(s.pdf);
    } catch {
      return { update: { rawText: "", fatal: "The file could not be opened as a PDF." }, summary: "The file could not be opened as a PDF.", status: "stopped" };
    }
  }
  if (text.replace(/\s/g, "").length < 40) {
    const why = "This PDF has no readable text. It may be a scan, so a person needs to read it.";
    return { update: { rawText: text, fatal: why }, summary: why, status: "stopped" };
  }
  return { update: { rawText: text }, summary: `Read ${text.split(/\r?\n/).length} lines of text.` };
});

const readRules = step("read_rules", (s) => {
  const f = extractWithRules(s.rawText);
  const n = Object.values(f).filter((v) => (Array.isArray(v) ? v.length : v)).length;
  return { update: { rulesFields: f }, summary: `Found ${f.items.length} item row(s) and ${n} fields.` };
});

const readAi = step("read_ai", async (s, config) => {
  const complete = completerOf(config);
  if (!complete) {
    return { update: { aiFields: null }, summary: "AI is off (no GROQ_API_KEY). Only the fixed reader was used.", status: "skipped" };
  }
  const { fields, error } = await extractWithAI(s.rawText, complete);
  if (error) {
    return { update: { aiFields: null }, summary: `The AI call failed (${error}). Only the fixed reader was used.`, status: "skipped" };
  }
  return { update: { aiFields: fields }, summary: `The AI returned ${fields!.items.length} item row(s).` };
});

const verify = step("verify", (s) => {
  const { fields, uncertainties } = reconcile(s.rawText, s.rulesFields!, s.aiFields ?? null);
  if (fields.items.length === 0 && uncertainties.length === 0) {
    const why = "No item rows could be read from this quotation, so a person needs to read it.";
    return { update: { fields, fatal: why }, summary: why, status: "stopped" };
  }
  const both = Object.values(fields).filter((v) => !Array.isArray(v) && v && (v as { source?: string }).source === "both").length;
  return {
    update: { fields, uncertainties },
    summary: uncertainties.length
      ? `${uncertainties.length} reading(s) could not be confirmed.`
      : `Every value has an exact quote.${s.aiFields ? ` ${both} fields agreed between the AI and the fixed reader.` : ""}`,
  };
});

const compare = step("compare", (s) => {
  const out = compareWithRequest(s.fields!, s.request);
  const failed = out.rules.filter((r) => r.status === "fail").map((r) => r.ruleId);
  return {
    update: { comparison: out.comparison, ruleResults: out.rules, uncertainties: out.uncertainties },
    summary: failed.length ? `Rules triggered: ${failed.join(", ")}.` : "Price and quantity match the request.",
  };
});

const contract = step("contract", (s) => {
  const out = checkContract(s.fields!, s.rawText, s.uncertainties);
  const failed = out.rules.filter((r) => r.status === "fail").map((r) => r.ruleId);
  return {
    update: { ruleResults: out.rules, uncertainties: out.uncertainties },
    summary: failed.length ? `Rules triggered: ${failed.join(", ")}.` : "No contract rule is triggered.",
  };
});

const decideStep = step("decide", (s) => {
  const d = decide(s.ruleResults, s.uncertainties, s.fatal);
  return { update: { decision: d.decision, reasons: d.reasons, questions: d.questions }, summary: d.decision };
});

const askPerson = step("ask_person", (s) => ({
  update: {},
  summary: `Stopped. ${s.questions.length} question(s) are waiting for a person.`,
  status: "stopped",
}));

export const graph = new StateGraph(State)
  .addNode("ingest", ingest)
  .addNode("read_rules", readRules)
  .addNode("read_ai", readAi)
  .addNode("verify", verify)
  .addNode("compare", compare)
  .addNode("contract", contract)
  .addNode("decide", decideStep)
  .addNode("ask_person", askPerson)
  .addEdge(START, "ingest")
  .addConditionalEdges("ingest", (s: S) => (s.fatal ? "decide" : "read_rules"), { decide: "decide", read_rules: "read_rules" })
  .addEdge("read_rules", "read_ai")
  .addEdge("read_ai", "verify")
  .addConditionalEdges("verify", (s: S) => (s.fatal ? "decide" : "compare"), { decide: "decide", compare: "compare" })
  .addEdge("compare", "contract")
  .addEdge("contract", "decide")
  .addConditionalEdges("decide", (s: S) => (s.decision === "Needs a person to check" ? "ask_person" : "end"), {
    ask_person: "ask_person",
    end: END,
  })
  .addEdge("ask_person", END)
  .compile();

export interface PipelineInput {
  filename: string;
  pdf?: Uint8Array;
  /** Skip PDF reading and use this text (used by tests). */
  text?: string;
  request: PurchaseRequestItem[];
  /** The AI call. Leave out to run with the fixed reader only. */
  complete?: Completer | null;
}

export async function runPipeline(input: PipelineInput): Promise<AnalysisResult> {
  const out = await graph.invoke(
    {
      filename: input.filename,
      pdf: input.pdf ?? null,
      rawText: input.text ?? "",
      request: input.request,
      fatal: null,
      rulesFields: null,
      aiFields: null,
      fields: null,
      comparison: [],
      decision: null,
      reasons: [],
      questions: [],
    },
    { configurable: { complete: input.complete ?? null } },
  );

  // Steps that never ran (because the PDF could not be read) are shown as skipped.
  const ran = new Set(out.trace.map((t) => t.step));
  const trace = [...out.trace];
  for (const st of STEPS) {
    if (!ran.has(st.id)) trace.push({ step: st.id, label: st.label, status: "skipped", summary: "Not run.", ms: 0 });
  }
  trace.sort((a, b) => STEPS.findIndex((x) => x.id === a.step) - STEPS.findIndex((x) => x.id === b.step));

  return {
    filename: input.filename,
    mode: input.complete ? { ai: "groq", model: aiModel() } : { ai: "off", model: null },
    fields: out.fields,
    comparison: out.comparison,
    rules: out.ruleResults,
    findings: out.ruleResults.flatMap((r) => r.findings),
    uncertainties: out.uncertainties,
    decision: out.decision!,
    reasons: out.reasons,
    questions: out.questions,
    trace,
    rawText: out.rawText,
  };
}
