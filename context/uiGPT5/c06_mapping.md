# Step 6 — Mapping handling

## What “mapping” means in your system

* The gateway needs a **`mapping`** when producing XML. For **PDF → XML**, it runs `PDF2JSON` then `JSON2XML` using the mapping you pass. For **JSON → XML**, it forwards directly to `JSON2XML` with that mapping. Invalid combos are rejected with **406**. &#x20;
* You already have a working mapping named **`pt_simon_invoice_v1`** (example shows `pt_simon_invoice_v1.json`). Keep using this as the default. &#x20;

## Where mappings live and how we name them

* **Source of truth** lives with the **JSON2XML** service (repo folder in that service). The gateway exposes a single `/process` endpoint and routes to JSON2XML internally. &#x20;
* **Naming**: `<domain>_<customer>_invoice_vN` (e.g., `pt_simon_invoice_v1`). If the JSON2XML service expects a filename, the worker can append `.json` when calling the gateway. Keep the Job’s `mapping` column **without** the extension for consistency.&#x20;
* **Versioning**: bump the suffix (`_v2`, `_v3`) when you change structure. Do not overwrite v1. The jobs table already carries `mapping`, and your dedupe key includes `mapping` so results from different versions never collide. &#x20;

## Contracts across web → worker → gateway

* **Upload API**: accept an optional `mapping` field in `POST /api/upload`. If absent, set to your default. Persist it in the `jobs.mapping`. &#x20;
* **Worker**: read `jobs.mapping` and call the gateway:

  * `POST /process` with the file, `Accept: application/xml`, `mapping=<name>`, optional `pretty=1`.&#x20;
* **Gateway behavior**: validates Accept + file type + mapping. Returns 400/406/413/415/502 on errors; file size limit is 50 MB. Surface those as your job `error_code` and `error_message`.&#x20;

## Security and validation

* **Allow-list**: only accept mappings from a **known list** on the server (e.g., `['pt_simon_invoice_v1', ...]`). Reject anything else with a friendly 400.
* **Filename safety**: JSON2XML already guards against path traversal in mapping filenames; keep your own allow-list so you never pass raw user input through.&#x20;
* **Dedupe**: your unique key includes `(sha256, mapping, bytes)` (or per-owner variant), so re-uploads with a **different mapping** will process independently as intended.&#x20;

## UI (now vs later)

* **Now**: hidden input or server default to `pt_simon_invoice_v1`. Keep it fixed on the UI to reduce choices.
* **Later**: a dropdown on the upload form that reads a **mapping registry** (static JSON) and sends the chosen mapping with each upload.
* **Queue page**: show the mapping as a subtle label in each row for transparency. (Helps when multiple templates exist.)&#x20;

## Mapping registry (simple approach)

* Create a small **registry** file (JSON or env) the web and worker can read:

  ```json
  {
    "default": "pt_simon_invoice_v1",
    "available": ["pt_simon_invoice_v1"]
  }
  ```
* The worker validates the job’s mapping against `available`. If invalid, mark the job `failed` with `GW_4XX` style message even before calling the gateway.

## Observability

* Log `mapping` on **upload**, **dispatch**, and **completion**. Include it in `job_events.meta` (HTTP status, duration, mapping). This ties directly into your event/audit plan.&#x20;
* For quick manual tests, you already have make targets like `make test-json-xml` and `make test-pdf-xml`. Use these to validate new mappings end-to-end before exposing them in UI.&#x20;

## Failure cases to standardize

* **Missing mapping when producing XML** → 400 with clear message.
* **Unknown mapping** → 400, “Unknown mapping” (do not forward to gateway).
* **Bad combo** (e.g., Accept XML but wrong file type) → 406 per gateway. Surface as `GW_4XX`.&#x20;
* **Gateway 5xx / timeout** → mark `failed` with `GW_5XX` or `GW_TIMEOUT`. You already set these in your error taxonomy.&#x20;

## Rollout for additional mappings

1. **Add the mapping** to the JSON2XML service (versioned name).
2. **Update the registry** (`available` list) and redeploy worker + web.
3. **Smoke test** with `make test-json-xml` and `make test-pdf-xml`.&#x20;
4. **Enable in UI** (dropdown) for specific tenants/users if needed.

## Acceptance checks for Step 6

* Upload without `mapping` creates a job with `mapping='pt_simon_invoice_v1'`. Worker produces XML via `/process` and completes. &#x20;
* Upload with an **allowed** mapping uses that value end-to-end and completes.
* Upload with an **unknown** mapping fails fast with a clean 400; the job lands in `failed` with an understandable `error_message`.
* Dedupe treats identical PDFs with **different mapping** as distinct work items (no accidental reuse).&#x20;
* Logs and `job_events` capture the mapping used on dispatch and completion.&#x20;
