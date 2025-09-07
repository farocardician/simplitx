# SKUBridge — High‑Level Plan (PIM + Enrichment)


## Vision
- Centralize product truth across vendors by capturing every seen SKU, curating canonical attributes once, and enriching future extractions automatically.
- Reduce fragile PDF parsing for descriptions by preferring canonical data when available; use the system as both a source of truth and a validator.

## Desired Outcomes
- Consistent line‑item outputs: stable description, UOM, HS code per SKU/vendor.
- Faster onboarding: new vendors require only column mapping; product details converge via curation.
- Feedback loop: new SKUs flow into a queue; admins curate once; all future documents benefit.

## Scope (What we will build)
- Data store (Postgres) for suppliers, canonical products, and supplier‑specific SKUs.
- Pipeline integrations for ingestion (post Stage 6) and enrichment/validation (Stage 6.5/7).
- Admin UI for review/edit/link workflows.
- Export/import tooling to operate with/without live DB access.
- Observability + policies for quality (validation, mismatches, drift).

## Architecture Overview
- Ingestion path: Stage 6 → Ingestion Writer → Postgres (upsert supplier_skus).
- Enrichment path: Stage 6.5/7 → Catalog Lookup (DB or exported JSON) → apply override/validate policy → final items.
- Admin path: Web UI → CRUD on products and supplier_skus (linking, editing, auditing).
- Optional text shaping: Stage 5 dictionary segmentation for readability only; not a source of truth.

## Data Model (Entities)
- suppliers: id, code (unique), name, metadata, timestamps.
- products (canonical): id, canon_sku (unique optional), description, uom, hs_code, active, metadata (JSON), timestamps.
- supplier_skus (vendor‑specific): id, supplier_id (FK), vendor_sku, product_id (FK nullable), raw_description, suggested_description, uom, hs_code, first_seen_at, last_seen_at, seen_count, last_doc_id, UNIQUE(supplier_id, vendor_sku).

## Ingestion (Post Stage 6)
- Inputs: supplier_code, vendor_sku, description (raw), uom, hs_code, doc_id.
- Operation: idempotent upsert into supplier_skus; update last_seen_at/doc; increment seen_count; opportunistically fill empty uom/hs_code.
- Optional suggestions: write suggested_description (e.g., from Stage 5 segmentation) for admin convenience.

## Enrichment + Validation (Stage 6.5/7)
- Lookup by (supplier_id, vendor_sku) → if linked to product:
  - Mode: override → set description/uom/hs_code from product; preserve raw in provenance; add note.
  - Mode: validate → compare parsed vs canonical; log ratio/decision; keep canonical or parsed per policy.
- Fallbacks: if no catalog match, keep parsed; optionally flag for admin review queue.

## Configuration & Policies
- catalog.enabled: true/false; source: db | file.
- catalog.mode: override | validate; fields: [description, uom, hs_code].
- validate.strategy: ratio | tokens; threshold; normalization toggles (upper, collapse_spaces, strip_punct).
- enrichment.notes: enable/disable short notes on decisions.
- export.path + schedule for file mode; db.dsn via env for live mode.

## Admin UX (MVP)
- Queues: New/Unlinked SKUs; Recently Updated; Mismatches.
- Actions: Edit suggested_description → canonical; set UOM/HS; create product; link to product; deactivate product.
- Context: history (first_seen_at, last_seen_at, seen_count, last_doc_id); supplier details; preview of recent documents.

## APIs & Services
- Catalog Read API: GET by (supplier_code, vendor_sku) → canonical fields + status.
- Ingestion API/Worker: upsert supplier_skus from pipeline events.
- Admin API: CRUD for products and supplier_skus; link/unlink; search.
- Exporter: nightly JSONL/CSV snapshot keyed by (supplier_code, vendor_sku).

## Optional Text Segmentation (Stage 5)
- Purpose: readability only (e.g., split fused uppercase runs in descriptions).
- Config‑driven: apply_to_families, candidate_regex, dictionary_files (global/domain/vendor), uom_list, regex_replacements.
- Guardrails: runs only on obvious candidates; never overwrites canonical data.

## Operations & DevOps
- Migrations: SQL for the three tables + indexes.
- Secrets: DB DSN via env/secret manager.
- Backups: scheduled DB backups; export snapshots archived.
- Deployment: containerized services; worker for ingestion; web for admin.

## Security & Compliance
- Access control: admin UI behind auth; write operations audited; PII not stored.
- Data retention: configurable archival of stale/unlinked SKUs.
- Provenance: keep doc_id and timestamps to trace sources.

## Performance & Scaling
- Indexes: UNIQUE(supplier_id, vendor_sku); idx(product_id), idx(supplier_id); optional GIN on products.metadata.
- Caching: in‑process LRU for enrichment lookups; optional Redis for shared cache.
- Throughput: ingestion is append/update; enrichment is read‑heavy; batch export for file mode.

## Observability
- Metrics: new SKUs/day, curated rate, enrichment hit‑rate, mismatch rate, mean time to curate.
- Logs: ingestion upserts, validation outcomes, admin actions (audit trail).
- Dashboards: queues, trend lines, top vendors by new SKUs.

## Rollout Plan
1) Schema + basic ingestion writer (post Stage 6) + live DB read for enrichment (override only).
2) Admin MVP for linking/editing; validation mode with notes; metrics/logging.
3) Export mode for pipelines without DB access; dictionary‑based Stage 5 (optional).
4) Hardening: caching, dashboards, RBAC, backup/restore drill.

## Risks & Mitigations
- SKU ambiguity across vendors → always key by (supplier_id, vendor_sku); use canon_sku only after deliberate consolidation.
- Over‑reliance on parsed descriptions → prefer catalog override when available.
- Admin backlog growth → prioritization queues, search, and bulk operations.

## Open Questions
- Canonical naming conventions: short label vs full marketing name vs attribute split.
- Attribute strategy: store structured attributes in products.metadata vs parse into separate columns.
- Multilingual handling: per vendor language or per market locale.

## Next Steps
- Approve schema and policies (override vs validate defaults).
- Implement ingestion writer and minimal enrichment layer (DB read).
- Stub Admin UI (list new/unlinked, edit/link forms) and start curation.
- Enable metrics + notes; iterate on thresholds and policies.
