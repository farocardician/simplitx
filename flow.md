### Current Flow (call graph with citations)
- Upload (`POST /api/upload`) saves the PDF to `uploads/{job}.pdf`, creates a `jobs` row, and marks it queued → `services/web/app/api/upload/route.ts:8`
- Worker loop leases `queued` jobs and calls `processJob` to handle the upload path → `services/worker/src/index.js:25`, `services/worker/src/processor.js:14`
- `processJob` posts the PDF to the gateway with `Accept: application/xml`, which chains pdf2json then json2xml before returning XML → `services/worker/src/processor.js:65`, `services/gateway/main.py:140`
- pdf2json executes the S1–S10 scripts defined in the template config and stage 10 persists `final.json` into `parser_results` → `services/pdf2json/processor.py:127`, `services/config/invoice_pt_simon.json:3`, `services/pdf2json/stages/s10_parser.py:63`
- Worker writes the returned XML to `results/{job}.xml`, optionally saves artifacts, and updates the job as `complete` → `services/worker/src/processor.js:28`, `services/worker/src/processor.js:46`
- Review API loads the saved XML (parsed back to JSON) or falls back to the stage-10 JSON for editing; the client fetches that payload for the React form → `services/web/app/api/review/[jobId]/route.ts:124`, `services/web/app/api/review/[jobId]/route.ts:355`, `services/web/app/review/[jobId]/page.tsx:320`
- Saving posts edits back to `/api/review/:jobId`, which merges them with parser metadata, regenerates XML via `buildInvoiceXml`, and overwrites `resultPath` → `services/web/app/api/review/[jobId]/route.ts:559`, `services/web/lib/xmlBuilder.ts:82`, `services/web/app/api/review/[jobId]/route.ts:788`
- Download endpoints gate on `job.status === 'complete'` and stream `resultPath` / `artifactPath` to the user → `services/web/app/api/jobs/[id]/download/route.ts:7`, `services/web/app/api/jobs/[id]/download-artifact/route.ts:7`

### Timeline (who/what/when/artifact)
| Step | Trigger | Code (file:line) | Artifact In | Artifact Out |
| --- | --- | --- | --- | --- |
| Upload & enqueue | User submits `/api/upload` | `services/web/app/api/upload/route.ts:8` | PDF upload | Stored `uploads/{job}.pdf`, `jobs.status=queued` |
| Worker lease | Background worker loop | `services/worker/src/index.js:25` | Queued job row | Job marked `processing` for exclusive handling |
| Gateway pdf→json→xml | Worker `callGateway` | `services/worker/src/processor.js:65`, `services/gateway/main.py:140` | PDF stream + template/mapping | pdf2json JSON + json2xml XML response |
| S1–S10 pipeline & persistence | Gateway calling pdf2json | `services/pdf2json/processor.py:127`, `services/config/invoice_pt_simon.json:3`, `services/pdf2json/stages/s10_parser.py:63` | PDF bytes | Stage outputs + `final.json` saved to disk and `parser_results` |
| Worker saves artifacts | Worker after gateway response | `services/worker/src/processor.js:28`, `services/worker/src/processor.js:37` | XML/ZIP buffers | `results/{job}.xml` + optional artifact ZIP |
| Job completion | Worker DB update | `services/worker/src/processor.js:46` | Job row | `jobs.status=complete`, `resultPath` persisted |
| Review data load | User opens `/review/:jobId` | `services/web/app/api/review/[jobId]/route.ts:124`, `services/web/app/api/review/[jobId]/route.ts:355`, `services/web/app/review/[jobId]/page.tsx:320` | Saved XML or parser JSON | Normalized JSON payload for form editing |
| Review save & XML rebuild | User clicks Save | `services/web/app/api/review/[jobId]/route.ts:559`, `services/web/lib/xmlBuilder.ts:82`, `services/web/app/api/review/[jobId]/route.ts:788` | Edited JSON items + buyer selection | Validated XML written back to `resultPath` |
| Download XML/artifacts | User clicks queue buttons | `services/web/app/api/jobs/[id]/download/route.ts:7`, `services/web/app/api/jobs/[id]/download-artifact/route.ts:7` | Saved files on disk | HTTP download responses |

### Evidence
* XML generation call site(s): Worker posts PDFs to the gateway with `Accept: application/xml`, enforcing the pdf2json→json2xml chain, and then writes the XML file for the job → `services/worker/src/processor.js:65`, `services/gateway/main.py:140`, `services/worker/src/processor.js:28`. Stage 10 also persists the JSON result to Postgres during the pipeline run → `services/pdf2json/stages/s10_parser.py:63` & `services/pdf2json/stages/s10_parser.py:638`, stored under the `parser_results` schema (`docId`, `final`, `manifest`) → `services/web/prisma/schema.prisma:71`. Manual review saves rebuild XML via `buildInvoiceXml` before writing the file → `services/web/app/api/review/[jobId]/route.ts:755`, `services/web/lib/xmlBuilder.ts:82`.
* Review data source: The API first attempts to parse the saved XML and merge it with parser metadata, falling back to `parser_results.final` if XML is missing, then returns that JSON to the React page which fetches `/api/review/:jobId` before rendering → `services/web/app/api/review/[jobId]/route.ts:124`, `services/web/app/api/review/[jobId]/route.ts:355`, `services/web/app/review/[jobId]/page.tsx:320`, `services/web/lib/xmlParser.ts:28`.
* Buttons gating: `/api/jobs` marks `canReview`/`canDownload` true only when `job.status === 'complete'`, and the `ActionButtons` component disables the Review/XML buttons whenever those flags are false → `services/web/app/api/jobs/route.ts:51`, `services/web/app/queue/components/ActionButtons.tsx:28`.
* Download routes/guards: The XML and artifact download endpoints both re-check ownership, require `status === 'complete'`, ensure `resultPath`/`artifactPath` exist, and stream the files from disk → `services/web/app/api/jobs/[id]/download/route.ts:7`, `services/web/app/api/jobs/[id]/download-artifact/route.ts:7`.

### Verdicts
- XML auto after S1–S10: **True** — As soon as the worker processes a job it calls the gateway with `Accept: application/xml`, which runs pdf2json (S1–S10) then json2xml in one request before saving `results/{job}.xml` and marking the job complete (`services/worker/src/processor.js:65`, `services/gateway/main.py:140`, `services/worker/src/processor.js:28`).
- Review page shows XML (not JSON): **False** — The review API parses the saved XML back into structured JSON (or falls back to the stored stage-10 JSON) and the React page edits those JSON fields; users never edit raw XML, only the normalized JSON payload (`services/web/app/api/review/[jobId]/route.ts:124`, `services/web/app/api/review/[jobId]/route.ts:355`, `services/web/app/review/[jobId]/page.tsx:320`).

### Notes/ambiguities
- The worker and web services both reference relative `results/{job}.xml` paths, so a shared volume or identical working directory layout is assumed for result access; mismatched mounts would break review/download even though the code expects a shared filesystem.
