import type { AnalysisResult, HumanReview, PurchaseRequestItem, StoredAnalysis } from "../types";

export interface Store {
  kind: "supabase" | "memory";
  getRequest(): Promise<PurchaseRequestItem[]>;
  replaceRequest(items: PurchaseRequestItem[]): Promise<void>;
  saveAnalysis(result: AnalysisResult): Promise<StoredAnalysis>;
  listAnalyses(): Promise<StoredAnalysis[]>;
  getAnalysis(id: string): Promise<StoredAnalysis | null>;
  addReview(id: string, review: Omit<HumanReview, "createdAt">): Promise<StoredAnalysis>;
}

export function statusFor(result: AnalysisResult): StoredAnalysis["status"] {
  return result.decision === "Needs a person to check" ? "awaiting_person" : "complete";
}
