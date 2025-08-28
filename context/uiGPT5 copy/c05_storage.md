# Step 5 — Storage and retention

## 1) What we store and where

**Now (local disk, Docker Option 2)**

* Root folders inside the web/worker containers:

  * `/app/uploads` for source PDFs
  * `/app/results` for generated XML
* File names:

  * `uploads/{jobId}.pdf`
  * `results/{jobId}.xml`
* Jobs table stores only server paths, never user filenames.

**Later (S3-compatible)**

* Bucket layout mirrors local:

  * `uploads/{jobId}.pdf`
  * `results/{jobId}.xml`
* Keep the DB schema the same. Only the read/write helpers change.

## 2) Directory growth

Start flat for dev. Before you have tens of thousands of files, switch to sharded paths:

* `uploads/{yy}/{mm}/{dd}/{jobId}.pdf`
* `results/{yy}/{mm}/{dd}/{jobId}.xml`
  DB still stores full server path or object key.

## 3) Atomic writes and integrity

* Write to a temp file, then rename:

  * `results/.tmp-{jobId}.xml` → `results/{jobId}.xml`
* After write, verify:

  * File exists
  * Size > 0
* Optional: store `sha256_xml` in the DB after write for later integrity checks.

## 4) Ownership and access

* Files live outside the public web root.
* Only the API serves downloads after verifying the job and session.
* Never trust `original_filename` for paths or responses.
* Set file permissions to read/write by the app user only.

## 5) Retention policy (pick defaults)

Recommend:

* **Source PDF TTL**: 7 days
* **XML TTL**: 30 days
* Optional “delete on first download” for XML if you want strict privacy.

These are config-driven so you can tune without redeploy:

* `PDF_TTL_DAYS`
* `XML_TTL_DAYS`
* `DELETE_XML_ON_FIRST_DOWNLOAD=true|false`

## 6) Cleanup job (daily)

A small daily job in the worker:

1. Find expired artifacts:

   * PDFs: `NOW() > expires_at` or `created_at + PDF_TTL`
   * XML: `NOW() > expires_at` or `completed_at + XML_TTL`, or `DELETE_XML_ON_FIRST_DOWNLOAD` and `download_count > 0`
2. Delete file from disk (or S3)
3. Update DB:

   * Keep the job row
   * Null out `upload_path` or `result_path`
   * Add a `job_event: expired` (optional)
4. Emit a short log summary: deleted count, total bytes freed

Protect in-flight work:

* Never delete a PDF while `status IN (queued, processing)`
* For safety, delete PDFs only when the job is terminal (complete or failed)

## 7) What happens after expiration

* **Download**: return 404 and show “Expired. Re-upload to regenerate.”
* **Dedupe**:

  * If you use per-owner dedupe and a completed result was expired, treat the next upload as a new job that reprocesses.
  * If you later adopt global dedupe and still want a fresh result, store the dedupe key but bypass reuse when `result_path` is null.

## 8) Disk pressure and quotas

* Config knobs:

  * `DISK_SOFT_LIMIT_BYTES` (warn)
  * `DISK_HARD_LIMIT_BYTES` (stop new uploads)
* Behavior:

  * If soft limit is crossed, log a warning and accelerate cleanup
  * If hard limit is crossed, reject new uploads with a friendly error until free space returns
* Quick metric: track current bytes under `/app/uploads` and `/app/results` in the daily job

## 9) Migration path to S3 (when ready)

**Config**

* `STORAGE_BACKEND=local|s3`
* For S3: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (for MinIO), creds via env/role

**Write/Read helpers**

* `putArtifact(kind, jobId, stream|buffer) → path_or_key`
* `getArtifact(kind, jobId) → stream`
* `deleteArtifact(kind, jobId)`
* `existsArtifact(kind, jobId) → bool`

**Downloads**

* Keep serving through your API
* Either stream from S3 through the server
* Or issue a short-lived pre-signed URL (60–120s), still behind ownership checks

**Backfill (optional)**

* A one-time migrator that copies local files to S3 and updates `path_or_key`
* Run in batches, verify checksums, then remove local copies

## 10) Security notes

* Validate PDF on upload and size on both client and server
* Never echo real server paths in errors
* For S3, avoid public buckets; use pre-signed URLs or server streaming
* Consider simple content scanning if you later accept more file types

## 11) Observability

* Log on every artifact write and delete: job id, kind, bytes, duration
* Daily cleanup log with totals
* Add gauges:

  * Count of PDFs/XMLs on disk
  * Total bytes by folder
  * Average time from complete to first download

## 12) Failure handling

* If writing XML fails:

  * Do not change status to complete
  * Set `status=failed`, `error_code=IO_ERROR`, `error_message`, and keep the temp file path in logs for investigation
* If cleanup fails to delete a file:

  * Keep retrying in the next run
  * If the DB says it’s deleted but the file remains, log and fix on next pass

## 13) Acceptance checks for Step 5

* Upload a PDF → file lands at `uploads/{jobId}.pdf` and path is saved in DB
* When a job completes → XML at `results/{jobId}.xml`, path saved in DB
* Daily cleanup removes artifacts beyond TTL and nulls the path fields
* Download after XML expiration returns 404 with a clear message
* Hitting hard disk limit blocks new uploads with a precise error and logs the reason
* Switching `STORAGE_BACKEND` from `local` to `s3` requires no API or DB changes