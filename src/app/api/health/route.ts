import { NextResponse } from "next/server";
import { aiEnabled, aiModel } from "@/lib/extract/llm";
import { getStore } from "@/lib/store";
import { listSamples } from "@/lib/sample";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getStore();
  let requestItems = 0;
  let error: string | null = null;
  try {
    requestItems = (await store.getRequest()).length;
  } catch (e) {
    error = e instanceof Error ? e.message : "Storage error";
  }
  return NextResponse.json({
    storage: store.kind,
    ai: aiEnabled() ? { enabled: true, model: aiModel() } : { enabled: false, model: null },
    requestItems,
    samples: listSamples().length,
    error,
  });
}
