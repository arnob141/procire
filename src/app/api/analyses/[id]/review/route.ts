import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["Approve", "Reject"]),
  note: z.string().trim().min(5, "Write a short reason (at least 5 characters)."),
  reviewer: z.string().trim().max(80).optional(),
});

/** A person answers a document the system stopped on. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid answer." }, { status: 400 });
  }
  try {
    const store = getStore();
    const row = await store.getAnalysis(id);
    if (!row) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    if (row.status !== "awaiting_person") {
      return NextResponse.json({ error: "This document is not waiting for a person." }, { status: 409 });
    }
    const saved = await store.addReview(id, {
      decision: parsed.data.decision,
      note: parsed.data.note,
      reviewer: parsed.data.reviewer || null,
    });
    return NextResponse.json({ id: saved.id, finalDecision: saved.finalDecision });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save." }, { status: 500 });
  }
}
