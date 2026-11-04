# Quote desk for Aamar Garments Ltd (fictional)

Reads supplier quotations, compares them with the purchase request, checks them against the company rules, and gives one answer per document: **Approve**, **Reject** or **Needs a person to check**, with the exact text from the document behind every reason. When it is not sure, it stops and asks a person.

Stack: Next.js 15 (App Router) and Tailwind CSS 4, LangGraph.js for the fixed steps, Groq (free model) for AI reading, Supabase (Postgres) for storage.

## Run it

```bash
npm install
cp .env.example .env.local      # then fill in the keys below (all optional to start)
npm run dev                     # http://localhost:3000
```

1. **Supabase** (optional to start): create a project, open SQL editor, run `supabase/schema.sql`. Put `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. The key stays on the server. Without these the app uses temporary in-memory storage (shown in a chip at the top of the page).
2. **Groq** (optional to start): create a free key at https://console.groq.com/keys and set `GROQ_API_KEY`. Default model is `llama-3.3-70b-versatile`; change it with `GROQ_MODEL` (for example `llama-3.1-8b-instant`). Without a key the app runs on the fixed reader only (shown in a chip).
3. Open the app, click **Load the sample purchase request**, then **Check the 10 sample quotations** (or drop your own PDFs).

```bash
npm test            # 20 tests: the 10 sample PDFs, evidence checks, and "never guess" cases
npm run samples     # prints PASS/FAIL for each sample PDF
```

## The fixed steps

`src/lib/graph.ts` is a LangGraph `StateGraph`. The order is written in code and never chosen by a model:

1. **Read the PDF** (`unpdf`). No text (a scan) means stop and ask a person.
2. **Read the layout with fixed patterns** (`extract/regex.ts`).
3. **Read the quotation with the AI** (`extract/llm.ts`, Groq, JSON mode, temperature 0). Every fact must come with a quote.
4. **Check every quote against the document** (`extract/reconcile.ts`).
5. **Compare with the purchase request** (`rules/compare.ts`): price and quantity, line by line.
6. **Check the contract rules** (`rules/contract.ts`).
7. **Give the final answer** (`rules/decide.ts`).
8. **Ask a person**, only when the answer is Needs a person to check. The person's Approve or Reject and reason are saved (`human_reviews`).

The only branches are two plain `if` checks: stop early if the PDF cannot be read, and ask a person when the answer is not a clear Approve or Reject.

## How it never guesses

- The AI only **copies facts and quotes**. It never decides. Approve, Reject and Needs a person to check come from plain code in `src/lib/rules/`, using exact decimal maths (`decimal.js`).
- Every value needs a quote that appears **word for word** in the PDF text, and the number must appear in its own quote. Otherwise the value is thrown away and flagged.
- The AI and the fixed reader read every field independently. If they **disagree**, the field is left empty and a person is asked.
- A rule that cannot be tested is marked "Could not be tested" and sent to a person. It is never passed by default.
- Doubt never causes a Reject. A Reject always rests on a verified quote (or on a confirmed absence, such as no penalty clause anywhere in the text).
- If the AI is off, fails or returns broken JSON, the fixed reader still works, and the step trace says the AI step was skipped.

## Decisions I made where the rules were silent

- **Penalty below the minimum** (rule note: at least 0.5% of order value per week): treated as **Needs a person to check** (rule id N1). The penalty also goes to a person if it is not stated per week or does not say it applies to order value. For example, Bhairab's "0.5% per week of delay" does not say what the percent applies to.
- **Rule order**: any Reject finding means Reject, even when other items need a check.
- **Delivery date**: quotes give a time after the purchase order ("within 4 weeks of PO"), not a calendar date. It is read as a time and converted to days (4 weeks = 28 days). No date is invented.
- **Payment range**: "30 to 90 days as agreed" is both open wording and outside 30 to 60 days. It is reported once.
- **Rounding**: money amounts match if they differ by no more than 0.01 BDT.
- **One purchase request per quote**: matched by the reference printed on the quotation, then by item letter, description and unit.

## Expected results for the sample pack

| File | Supplier | Answer | Why |
|---|---|---|---|
| 01 | Padma Textile Mills | Approve | All rules pass |
| 02 | Jamuna Trims | Approve | All rules pass |
| 03 | Karnaphuli Yarn | Reject | R1: 229.00 is 9.05% above 210.00 |
| 04 | Surma Packaging | Needs a person to check | C1: 6.65 is 2.31% above 6.50 |
| 05 | Meghna Carton | Reject | R2: 40% advance |
| 06 | Teesta Fabrics | Reject | R3: no late-delivery clause |
| 07 | Rupsha Zipper | Needs a person to check | C2: 16,500 vs 20,000 (17.5% below) |
| 08 | Bhairab Thread | Reject | R4: no TIN or BIN (also N1) |
| 09 | Dhaleshwari Poly | Needs a person to check | C3 open payment terms, C6 line total 322,000 should be 320,000 |
| 10 | Kushiyara Box | Reject | R5: 60 days delivery (also C5, VAT included) |

## Notes

- Free Groq limits (checked at build time, confirm in your console): about 12,000 tokens per minute and 100,000 per day on `llama-3.3-70b-versatile`. The upload panel checks one file at a time and the Groq call retries on rate limits.
- `data/samples/` is read by the "sample" buttons. If you deploy to a host that does not ship that folder, those buttons simply will not appear; uploads still work.
- Scanned PDFs have no text layer. They are sent to a person rather than OCR'd.
