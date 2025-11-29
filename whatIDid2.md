# Normalized buyer/seller data for invoices

- Added migration `007_normalize_buyer_seller.sql`:
  - Added `seller_id` to `job_config` and seller metadata columns (`seller_idtku`, `tax_invoice_opt`) to `public.parties`.
  - Dropped duplicated buyer/seller columns from `tax_invoices` and created view `tax_invoices_enriched` to expose derived buyer/seller fields via joins.
  - Ensured completeness columns exist on `tax_invoices`.
- Updated XLS ingest:
  - Stage 1 now reads pipeline config to persist `seller_id` into `job_config`.
  - Stage 3 now resolves seller via `job_config.seller_id` (fallback to config), fetches buyer/seller data from `parties`, computes missing fields from party data, and upserts invoices without denormalized buyer/seller columns.
- SQL2XML exporter now reads from `tax_invoices_enriched` (joined buyer/seller metadata) instead of raw table columns.
- Web API queries switched to `tax_invoices_enriched` for reads (list, search, buyers, upload-xls, bulk-download) and buyer-link/resolve routes were simplified to update only `buyer_party_id` + completeness (no denormalized buyer columns).
- Prisma schema updated to include new seller fields on `Party`.
