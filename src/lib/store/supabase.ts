import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisResult, HumanReview, PurchaseRequestItem, StoredAnalysis } from "../types";
import { D } from "../money";
import { statusFor, type Store } from "./types";

interface AnalysisRow {
  id: string;
  created_at: string;
  status: StoredAnalysis["status"];
  decision: StoredAnalysis["decision"];
  final_decision: StoredAnalysis["finalDecision"];
  result: AnalysisResult;
  human_reviews?: { decision: "Approve" | "Reject"; note: string; reviewer: string | null; created_at: string }[] | null;
}

const toStored = (r: AnalysisRow): StoredAnalysis => {
  const h = r.human_reviews?.[0];
  return {
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    decision: r.decision,
    finalDecision: r.final_decision,
    result: r.result,
    review: h ? { decision: h.decision, note: h.note, reviewer: h.reviewer, createdAt: h.created_at } : null,
  };
};

const SELECT = "id, created_at, status, decision, final_decision, result, human_reviews(decision, note, reviewer, created_at)";

function fail(where: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${where} failed: ${error?.message ?? "unknown error"}. Check the schema was created (supabase/schema.sql) and the keys in .env.local.`);
}

export function supabaseStore(): Store {
  const db: SupabaseClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  return {
    kind: "supabase",

    async getRequest() {
      const { data, error } = await db.from("purchase_request_items").select("*").order("pr_number").order("item");
      if (error) fail("reading the purchase request", error);
      return (data ?? []).map((r) => ({
        prNumber: r.pr_number,
        item: r.item,
        description: r.description,
        unit: r.unit,
        quantityRequested: Number(r.quantity_requested),
        maxUnitPrice: D(r.max_unit_price).toFixed(2),
      }));
    },

    async replaceRequest(items: PurchaseRequestItem[]) {
      const del = await db.from("purchase_request_items").delete().gte("id", 0);
      if (del.error) fail("clearing the purchase request", del.error);
      const ins = await db.from("purchase_request_items").insert(
        items.map((i) => ({
          pr_number: i.prNumber, item: i.item, description: i.description, unit: i.unit,
          quantity_requested: i.quantityRequested, max_unit_price: i.maxUnitPrice,
        })),
      );
      if (ins.error) fail("saving the purchase request", ins.error);
    },

    async saveAnalysis(result: AnalysisResult) {
      const status = statusFor(result);
      const { data, error } = await db
        .from("analyses")
        .insert({
          filename: result.filename,
          supplier_name: result.fields?.supplierName?.value ?? null,
          quotation_no: result.fields?.quotationNo?.value ?? null,
          pr_number: result.fields?.prReference?.value ?? null,
          decision: result.decision,
          status,
          final_decision: result.decision,
          result,
        })
        .select(SELECT)
        .single();
      if (error) fail("saving the analysis", error);
      return toStored(data as unknown as AnalysisRow);
    },

    async listAnalyses() {
      const { data, error } = await db.from("analyses").select(SELECT).order("created_at", { ascending: false });
      if (error) fail("listing analyses", error);
      return (data as unknown as AnalysisRow[]).map(toStored);
    },

    async getAnalysis(id: string) {
      const { data, error } = await db.from("analyses").select(SELECT).eq("id", id).maybeSingle();
      if (error) fail("reading the analysis", error);
      return data ? toStored(data as unknown as AnalysisRow) : null;
    },

    async addReview(id: string, review: Omit<HumanReview, "createdAt">) {
      const ins = await db
        .from("human_reviews")
        .insert({ analysis_id: id, decision: review.decision, note: review.note, reviewer: review.reviewer });
      if (ins.error) fail("saving the review", ins.error);
      const upd = await db.from("analyses").update({ status: "resolved", final_decision: review.decision }).eq("id", id);
      if (upd.error) fail("closing the analysis", upd.error);
      const row = await this.getAnalysis(id);
      if (!row) throw new Error("Analysis not found.");
      return row;
    },
  };
}
