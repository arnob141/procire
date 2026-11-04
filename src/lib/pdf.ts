import { extractText, getDocumentProxy } from "unpdf";

/** Read the text of a PDF. Returns "" for a scanned PDF with no text layer. */
export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).trim();
}
