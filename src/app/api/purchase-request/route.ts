import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { parsePurchaseRequestCsv } from "@/lib/pr";
import { readSampleRequestCsv } from "@/lib/sample";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replace the purchase request. Send a CSV file as form field "file", or {"sample": true} to load the bundled one. */
export async function POST(req: Request) {
  try {
    let csv: string | null = null;
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      const body = await req.json();
      if (body?.sample) csv = readSampleRequestCsv();
      if (!csv) return NextResponse.json({ error: "No sample purchase request is bundled with this app." }, { status: 400 });
    } else {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
      if (file.size > 1_000_000) return NextResponse.json({ error: "The file is larger than 1 MB." }, { status: 400 });
      csv = await file.text();
    }
    const items = parsePurchaseRequestCsv(csv);
    await getStore().replaceRequest(items);
    return NextResponse.json({ items: items.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the file." }, { status: 400 });
  }
}
