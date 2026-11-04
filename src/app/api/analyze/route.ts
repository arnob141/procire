import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/graph";
import { aiEnabled, groqCompleter } from "@/lib/extract/llm";
import { getStore } from "@/lib/store";
import { readSample } from "@/lib/sample";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

/** Check one quotation. One file per request, so the page can show progress file by file. */
export async function POST(req: Request) {
  try {
    const store = getStore();
    const request = await store.getRequest();
    if (request.length === 0) {
      return NextResponse.json({ error: "Load the purchase request first. Price and quantity cannot be compared without it." }, { status: 400 });
    }

    let filename: string;
    let bytes: Uint8Array | null;
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = await req.json();
      filename = String(body?.sample ?? "");
      bytes = readSample(filename);
      if (!bytes) return NextResponse.json({ error: "That sample file does not exist." }, { status: 400 });
    } else {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "Choose a PDF file." }, { status: 400 });
      if (file.size > MAX_BYTES) return NextResponse.json({ error: `${file.name} is larger than 10 MB.` }, { status: 400 });
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") {
        return NextResponse.json({ error: `${file.name} is not a PDF file.` }, { status: 400 });
      }
    }

    const result = await runPipeline({
      filename,
      pdf: bytes,
      request,
      complete: aiEnabled() ? groqCompleter() : null,
    });
    const saved = await store.saveAnalysis(result);
    return NextResponse.json({ id: saved.id, decision: saved.decision, filename });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The check failed." }, { status: 500 });
  }
}
