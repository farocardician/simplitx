Drag & drop PDFs DB-driven detect PLAN

Drag & drop PDFs → DB-driven detect (client/doc/file type) → Process via existing pipeline → Download.
Everything backed by Postgres+Prisma. Multi-file friendly. Worker and pipeline stay unchanged.

# 1) Data model (Prisma, no code shown)

* **FileType**: id, label, mimeTypes\[], extensions\[], maxSizeMB, enabled, createdAt/updatedAt.
* **Client**: id, name, enabled.
* **DocType**: id, name, enabled.
* **Template**: id, name, clientId FK, docTypeId FK, priority, threshold, enabled, notes.

  * **matchRules JSONB**:

    * `keywords: [{text, weight}]`
    * `regexes: [{pattern, flags?, weight}]`
    * `layoutHints: [{token, page?, region?, weight}]`
    * `requiredAny: [ruleKey...]`, `requiredAll: [ruleKey...]`
    * `negativeSignals: [{pattern|text, weight}]`
* **UploadSession**: id, ownerSessionId, createdAt.
* **UploadFile**: id, uploadSessionId FK, originalFilename, bytes, sha256, contentType, size, storagePath, createdAt.

  * detectionStatus: queued|processing|done|failed
  * detectionScores JSONB: \[{templateId, score, topSignals\[]}]
  * selectedTemplateId (nullable, manual override)
  * validationErrors\[] (from FileType rules)
* **Job**: current fields you already have, plus `uploadFileId FK`, `templateId FK`, `mappingKey` if your worker needs the old mapping string for backward compatibility.
* **AuditLog**: id, actor (sessionId), action, targetType, targetId, payload JSONB, createdAt.
  Tracks overrides, reprocessing, template changes.
* **DownloadEvent**: id, jobId FK, at.

# 2) Detection strategy (fast, resilient, DB-driven)

* **Input**: Uploaded PDF file.
* **Extractor**: Run lightweight pipeline subset for detection only:

  * s01\_tokenizer + s02\_normalizer on first N pages (e.g., 2) to produce normalized tokens and plain text.
  * Optional: cheaply detect table header tokens from s04\_camelot\_grid on the first table page if present.
* **Scoring**:

  * For each enabled Template, compute a weighted score from `matchRules` against extracted text/tokens.
  * Apply penalties for `negativeSignals`. Enforce `requiredAll` and short-circuit if unmet.
  * Keep top-N candidates with scores and the winning `templateId` if `score ≥ threshold`.
* **Outputs**:

  * Persist `detectionScores` and `detectionStatus=done`.
  * If no template meets threshold, mark “Unmatched” and allow manual selection in UI.

# 3) Validation strategy (DB-driven)

* At app init or on demand, UI fetches **FileType** definitions.
* Dropzone validates extension, MIME, size based on **FileType** records.
* Server re-validates every upload; return inline `validationErrors` per file card.

# 4) API surface (Next.js routes, stable contracts)

* **GET /api/file-types** → list of enabled FileType for the dropzone.
* **POST /api/upload** (multi-file)

  * Creates **UploadSession** if none exists, saves **UploadFile** rows, kicks off detection tasks per file.
  * Returns sessionId and file cards: {fileId, name, size, validationErrors?, detectionStatus, topCandidates?}
* **GET /api/templates** → list of enabled Templates with Client + DocType labels for manual override dropdown.
* **PATCH /api/upload/{fileId}/selection** → set `selectedTemplateId` for a file, log in AuditLog.
* **POST /api/process**

  * Input: fileIds\[] (or “all in session”).
  * For each file, resolve `templateId` = selectedTemplateId or best match; create **Job** rows binding file and template; enqueue into the existing worker pipeline. Return jobIds.
* **GET /api/jobs** (existing) → queue page uses this unchanged.
* **GET /api/jobs/{id}/download** (existing) → unchanged.

# 5) Worker and pipeline integration

* Worker remains the same for orchestration and status flow.
* Minimal change: when creating a Job, pass along `templateId` and, if needed, a `mappingKey` the pipeline expects.
* PDF2JSON → JSON2XML stages stay as is. Detection is separate and finishes before a Job exists.

# 6) Frontend UX (multi-file, clear, no modals)

**Home page**

* Dropzone reads **FileType** from API to show allowed types and limits.
* On drop:

  * Immediately shows file cards with local optimistic state.
  * After server ack, each card updates with server validation status and detection status.
* **File card contents**:

  * Filename, size, server validation errors (inline).
  * Detection status badge: Processing → Detected “Client • Doc Type” or Unmatched.
  * Top candidates hover/detail: show top 3 with scores.
  * Manual override dropdown (disabled until detection done).
  * Actions: **Process** (single) and **Remove**.
* **Batch actions**: Select all valid files → **Process Selected**.
* Success toast links to **Queue**.

**Queue page**

* Keep your existing polling and status display.
* Add columns for Client, Doc Type, Template name.
* Link back to the upload session if useful.

# 7) Concurrency, scaling, and performance

* Detection tasks:

  * Run in the web service queue or a light worker pool separate from the heavy PDF2JSON pipeline to keep upload UX snappy.
  * Cap CPU per detection process and limit pages scanned.
* Storage:

  * Save original PDF once on upload. Reuse for detection and processing to avoid duplicate IO.
* Hashing:

  * Use `sha256` to de-dupe optionally. If duplicate is dropped, surface a friendly note on the card.

# 8) Errors, retries, and fallbacks

* Validation errors: visible on cards, prevent processing.
* Detection failures:

  * Auto-retry once, then mark failed with an inline reason. Allow manual template selection to proceed.
* Processing failures:

  * Keep Job status and error. Allow “Reprocess” if desired.
* Always write to **AuditLog** on overrides and reprocess.

# 9) Security and data handling

* Enforce server-side validation of content type and size.
* Quarantine on MIME spoofing.
* Session-scoped access: only the session owner sees its upload files and jobs.
* Data retention policy:

  * Originals and outputs TTL configurable per environment.
  * Log downloads via **DownloadEvent**.

# 10) Observability

* Structured logs around upload, detection latency, detection match rate, process time, success rate, download conversions.
* Add simple counters:

  * detection\_success\_rate, unmatched\_rate, avg\_detection\_ms, avg\_pages\_scanned.
* Trace IDs passed from upload → detection → job → download.

# 11) Admin utilities

* Simple admin page to CRUD **FileType**, **Client**, **DocType**, **Template** and to edit **matchRules** JSON with a schema-aided editor.
* “Test rules” tool: paste sample text, see scores for each template.

# 12) Rollout plan (phased, shippable)

**Phase 1 — DB groundwork and upload UX**

* Add models: FileType, Client, DocType, Template, UploadSession, UploadFile, AuditLog.
* GET /api/file-types and POST /api/upload with multi-file support.
* Show file cards with server validation. Detection stub returns “pending”.
* Acceptance: Drop 10 PDFs of mixed sizes. Invalid ones block. Valid ones show as uploaded. No processing yet.

**Phase 2 — Detection service**

* Implement lightweight detection pipeline and scorer.
* Store `detectionScores`, surface top candidates and status per file.
* Manual override dropdown wired.
* Acceptance: For known PT Simon invoices, auto select template ≥ threshold. For unknown PDFs, show Unmatched and allow override.

**Phase 3 — Processing integration**

* POST /api/process creates Jobs using chosen template.
* Queue page shows Client/DocType columns.
* Acceptance: End-to-end run. Multiple files processed. Existing download works. Worker unchanged.

**Phase 4 — Polish and guardrails**

* Retries, better inline errors, dedupe by sha256, audit logging, unmatched analytics, admin rule editor.
* Acceptance: Observability dashboards show detection rates. Admin can tweak thresholds without deploys.

# 13) Test plan

* **Unit**: scorer against synthetic texts for each rule type; threshold and negative signal behavior.
* **Integration**: upload → detection → override → process on a small corpus of real PDFs.
* **UX**: 10+ file batch with mixed validity, ensure the page stays responsive and states are consistent after refresh.
* **Non-functional**: 100 PDFs in parallel, measure detection P95 latency and queue stability.

# 14) Success metrics

* ≥ 95% auto-match on supported templates within 2 seconds per file (P95) on 2-page scan.
* ≤ 1% false-positive rate at chosen thresholds.
* 0 code changes needed to add a new client/doc type. Admin can add Template and rules, and it works.

# 15) Risks and mitigations

* **Ambiguous templates**: close scores within epsilon. Mitigation: require manual confirm when delta < X and record feedback to improve rules.
* **Large PDFs**: cap detection to first N pages, expose “scan more pages” in admin for tricky templates.
* **Rule drift**: templates change in the wild. Mitigation: track unmatched samples and schedule periodic rule reviews.
