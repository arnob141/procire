import { randomUUID } from "node:crypto";
import type { HumanReview, PurchaseRequestItem, StoredAnalysis, AnalysisResult } from "../types";
import { statusFor, type Store } from "./types";

// Kept on globalThis so it survives hot reloads in `next dev`. Lost when the server stops.
const g = globalThis as unknown as { __memStore?: { request: PurchaseRequestItem[]; analyses: StoredAnalysis[] } };
const db = (g.__memStore ??= { request: [], analyses: [] });

export const memoryStore: Store = {
  kind: "memory",
  async getRequest() {
    return db.request;
  },
  async replaceRequest(items) {
    db.request = items;
  },
  async saveAnalysis(result: AnalysisResult) {
    const row: StoredAnalysis = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: statusFor(result),
      decision: result.decision,
      finalDecision: result.decision,
      result,
      review: null,
    };
    db.analyses.unshift(row);
    return row;
  },
  async listAnalyses() {
    return db.analyses;
  },
  async getAnalysis(id) {
    return db.analyses.find((a) => a.id === id) ?? null;
  },
  async addReview(id, review: Omit<HumanReview, "createdAt">) {
    const row = db.analyses.find((a) => a.id === id);
    if (!row) throw new Error("Analysis not found.");
    row.review = { ...review, createdAt: new Date().toISOString() };
    row.status = "resolved";
    row.finalDecision = review.decision;
    return row;
  },
};
