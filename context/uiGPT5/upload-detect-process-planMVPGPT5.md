# MVP: Drag & Drop → Detect → Process → Download (DB-driven)

## 1) Outcome

A simple, reliable multi-file flow where the UI and API are fully **DB-driven** (Postgres + Prisma), detection is fast and explainable, processing reuses the **existing pipeline**, and users can download results individually or in bulk.

## 2) Non-Goals (for MVP)

* No code-generated rules or ML.
* No changes to the PDF2JSON → JSON2XML stages or worker orchestration.
* No SSO or multi-tenant RBAC (session-scoped access only).

---

## 3) Data Model (conceptual)

* **FileType**: `id, label, extensions[], mimeTypes[], maxSizeMB, enabled, createdAt, updatedAt`
* **Client**: `id, name, enabled`
* **DocType**: `id, name, enabled`
* **Template**: `id, name, clientId, docTypeId, priority, threshold, enabled, version, updatedAt, notes, matchRules JSONB`
  `matchRules` supports: `keywords[]`, `regexes[]`, `layoutHints[]`, `negativeSignals[]`, `requiredAll[]`, `requiredAny[]`
* **UploadSession**: `id, ownerSessionId, createdAt`
* **UploadFile**:
  `id, uploadSessionId, originalFilename, size, contentType, sha256, storagePath, createdAt, validationErrors[]`
  Detection fields:
  `detectionStatus (queued|processing|done|failed), detectionScores JSONB[{templateId, score}], winningTemplateId, selectedTemplateId, confidenceScore(0–100), confidenceBand(HIGH|MEDIUM|LOW|UNMATCHED), explanations JSONB[{signal, weight}], previewThumbPath`
* **DetectionCache**: `sha256 (PK), result JSONB, templateVersionMap JSONB, expiresAt` (7-day TTL)
* **Job** (extends current): `id, uploadFileId, templateId, templateVersion, status, …` (keep `mappingKey` only if worker needs it)
* **AuditLog**: `id, actorSessionId, action, targetType, targetId, payload JSONB, createdAt`
* **DownloadEvent**: `id, jobId, createdAt`

---

## 4) Detection (fast, cached, progressive)

* **Trigger**: Async on upload (never block the upload request).
* **Lightweight extraction**: Run a minimal subset (tokenize + normalize). Optionally peek table headers if cheaply available.
* **Progressive scoring**:
  Start with page 1 → score all enabled templates → if `confidence < 70%`, add page 2 → stop when `confidence > 85%` or after a max page cap (e.g., 5). Persist pages scanned as a metric.
* **Confidence bands**:
  HIGH >85%, MEDIUM 70–85%, LOW 50–70%, UNMATCHED <50% (thresholds stored in DB/config).
* **Explanations**: Store top 3 signals (e.g., “matched regex: FAKTUR PAJAK”, “header token”, “supplier name”).
* **Caching**:

  * Look up by `sha256`. If cache not expired and template versions match, reuse immediately.
  * Write back results with a 7-day TTL and the templateId→version map.
  * Invalidate on Template `version` change.
* **Preview**: Generate a 200×300 first-page thumbnail asynchronously (best-effort; never blocks detection).

---

## 5) Validation (DB-driven)

* Dropzone reads **FileType** to show allowed types/limits.
* Server re-validates on upload; store any `validationErrors` on the file record.

---

## 6) API (contracts, no code)

**Public (session-scoped):**

* `GET /api/file-types` → FileType rules
* `POST /api/upload` → creates `UploadSession`, stores `UploadFile` rows, queues detection; returns per-file states
* `GET /api/templates` → enabled templates with Client/DocType labels
* `PATCH /api/upload/{fileId}/selection` → set `selectedTemplateId`
* `POST /api/process` → input: `fileIds[]` or “all in session”; **atomic** creation of Jobs; enqueue to existing worker
* `GET /api/jobs` and `GET /api/jobs/{id}/download` → unchanged
* **NEW** `POST /api/jobs/download-batch` → returns streamed ZIP + `manifest.json`
* **Graceful mode**: If detector is down, UI exposes **“Skip Detection”** and allows manual template selection

**Ops/Admin:**

* **NEW** `GET /api/metrics/detection` → match rate, unmatched rate, p95 latency, cache hit rate, per-template distribution (rolling/cached)
* Template CRUD (basic) with **hot-reload**: bump `version` and notify detectors (polling or Redis pub/sub)

---

## 7) Frontend UX

**Upload page**

* Multi-file drag & drop.
* File cards show: name/size, validation errors (inline), detection status, **confidence band**, top candidates, **top 3 explanations**, preview thumbnail (when ready).
* Manual override dropdown after detection or immediately on **“Skip Detection.”**
* Actions: **Process** (single) and **Process Selected** (batch).
* Optional: **Processing time estimate** bands based on page count + historical per-template timings (clearly labeled as estimate).

**Queue page**

* Keep existing polling. Add columns: Client, Doc Type, Template, Confidence Band.
* **Bulk Download** when multiple jobs are complete.

**Errors**

* User-friendly categories: `INVALID_PDF`, `EXTRACTION_FAILED`, `TEMPLATE_MISMATCH`, `PIPELINE_ERROR`.
* Store raw details server-side; keep UI copy simple.

---

## 8) Worker & Pipeline (unchanged)

* Worker orchestrates the same stages.
* When creating Jobs, pass `templateId` (+ optional `mappingKey`) and store `templateVersion`.
* No changes to processing logic; only inputs/metadata are enriched.

---

## 9) Observability & Metrics

* Detection: success rate, unmatched rate, avg/p95 latency, avg pages scanned, cache hit rate, per-template distribution.
* Processing: p50/p95 per template, failure rate by error category.
* Trace IDs from upload → detection → job → download.
* `GET /api/metrics/detection` serves a cached, auth-protected snapshot.

---

## 10) Security & Data Handling

* Server-side validation of MIME/extension/size; quarantine spoofed files.
* **Session-scoped access** from Phase 1.
* Retention: configurable TTLs for originals, outputs, thumbnails, caches.
* Rate-limit uploads; audit overrides, skip-detection, reprocess.

---

## 11) Rollout (phases with acceptance)

### Phase 1 — Foundation & Atomic Processing

* Models: FileType, Client, DocType, Template(with `version`), UploadSession, UploadFile, AuditLog.
* Session-scoped access on all resources.
* `GET /api/file-types`, `POST /api/upload` (multi-file, queues stub detection), `POST /api/process` (atomic).
  **Accept:**
* Upload 10 mixed files; invalid ones blocked by DB rules.
* Trigger a fault on the 3rd of 5 files during “Process Selected” → no jobs created (all-or-nothing).

### Phase 2 — Detection v1 (Progressive + Cache + Bands + Explanations + Preview)

* Async detection with progressive page scanning and early stop.
* Cache keyed by `sha256` with 7-day TTL and version-aware invalidation.
* Confidence bands + top-3 explanations persisted.
* Async thumbnail preview.
  **Accept:**
* Re-upload same file → cached result <100ms.
* 100-page mock → stops after ≤2 pages once confidence >85%.
* Verify band edges: 69.9%, 70.0%, 85.0% map correctly.

### Phase 3 — UX Resilience & Downloads

* “Skip Detection” path; manual override works even if detector is down.
* Error taxonomy mapped end-to-end.
* Bulk download ZIP with `manifest.json`.
  **Accept:**
* Kill detector → user can still choose a template and process.
* Process 5 jobs → download ZIP; all outputs present and valid.

### Phase 4 — Ops & Hot-Reload & Estimates

* `GET /api/metrics/detection` with cached rolling aggregates.
* Template hot-reload (poll or Redis pub/sub) — version bump applies immediately.
* Show processing time estimates (wide bands).
  **Accept:**
* Change template threshold → next detection uses new value without restart.
* Metrics reflect a 100-file run within ±1% of ground truth.

---

## 12) Test Plan (targeted)

* **Caching**: duplicate uploads use cache; template version bump invalidates.
* **Progressive**: confidence rises as pages added; hard cap enforced.
* **Bands**: verify boundary behavior.
* **Atomicity**: batch process rolls back on any failure.
* **Metrics**: endpoint values vs ground truth (±1%).
* **Hot-reload**: detectors pick up new template version without restart.
* **Preview**: always best-effort; detection never waits on it.
* **Explanations**: expected signals appear for known templates.
* **Bulk download**: ZIP integrity, filenames, manifest mapping.
* **Errors**: each category is triggerable and correctly surfaced.
* **Estimates**: 10-page vs 100-page within 20% of actual.

---

## 13) Success Metrics (ship gate)

* ≥95% auto-match on supported templates with P95 detection <2s (progressive).
* ≤1% false positives at chosen thresholds.
* > 50% detection cache hit within 7 days on typical usage.
* 0 deploys needed to onboard a new client/doc type (rule edits only).
* Upload and queue UIs responsive under 100 parallel uploads.

---

## 14) Risks & Mitigations

* **Ambiguous templates** (close scores): require manual confirm when score delta \<X; capture feedback to refine rules.
* **Template drift**: review unmatched/low-confidence samples weekly; adjust rules/thresholds.
* **Very large PDFs**: cap progressive pages; expose per-template knob.
* **Cache staleness**: tie validity to `Template.version`; expire on change.
