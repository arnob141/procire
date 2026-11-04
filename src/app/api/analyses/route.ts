import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await getStore().listAnalyses();
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id, createdAt: r.createdAt, filename: r.result.filename,
        supplier: r.result.fields?.supplierName?.value ?? null,
        decision: r.decision, status: r.status, finalDecision: r.finalDecision,
      })),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load." }, { status: 500 });
  }
}
