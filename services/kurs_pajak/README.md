# Kurs Pajak Loader

Scraper-loader service for Indonesia's **Kurs Pajak** exchange rates. The service fetches the weekly FX table published by Kementerian Keuangan, normalises the data, performs idempotent upserts into Postgres, creates encrypted backups before writes, and exposes both CLI tooling and an HTTP read API.

## Architecture

- `scraper.py` fetches the public listing and detail pages using resilient HTTP retries.
- `parser.py` extracts period metadata (Tanggal Berlaku, KMK number, PDF link) and all currencies, normalising Indonesian number formats.
- `loader.py` performs deduplicated inserts/updates with a pre-write `pg_dump` backup managed by `backup.py`.
- `scheduler.py` keeps the database current (Wednesday→Tuesday windows in `Asia/Jakarta`) and backfills history.
- `app.py` is a FastAPI service exposing `/health` and `/rate` (per-1 unit values) while running the scheduler loop.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres DSN (e.g. `postgresql://user:pass@host:5432/db`) | **required** |
| `KURS_PAJAK_BASE_URL` | Source listing URL | `https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak` |
| `TIMEZONE` | Service timezone | `Asia/Jakarta` |
| `HTTP_TIMEOUT_SECONDS` | HTTP timeout per request | `30` |
| `HTTP_RETRIES` | HTTP retries with backoff | `3` |
| `SCRAPER_MAX_PAGES` | Max listing pages to traverse | `40` |
| `SERVICE_POLL_INTERVAL_SECONDS` | Scheduler cadence (seconds) | `86400` (*daily*) |
| `SERVICE_LOOKBACK_WEEKS` | Historical window pulled each tick | `12` |
| `SERVICE_STARTUP_BACKFILL` | Fetch full history at startup | `true` |
| `BACKUP_TARGET_URL` | Backup destination (`file:///...`, `s3://bucket/prefix`, `gs://bucket/prefix`) | **required when backups enabled** |
| `BACKUP_ENCRYPTION_KEY` | Base64 Fernet key (`openssl rand -base64 32`) | **required when backups enabled** |
| `BACKUP_RETENTION_DAYS` | Retention horizon for backups | `30` |
| `BACKUP_ENABLED` | Toggle backups | `true` |

## CLI Usage

Install locally:

```bash
pip install -e services/kurs_pajak
export DATABASE_URL=postgresql://...
export BACKUP_TARGET_URL=file:///tmp/kurs-backups
export BACKUP_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Commands:

```bash
# Load the current week (Wed→Tue) and upsert
kurs-pajak load

# Load the week containing a specific date
kurs-pajak load --date 2024-10-16

# Backfill weekly periods since a given date
kurs-pajak load --since 2024-01-01

# Read path: per-1 unit rate (unit-normalised)
kurs-pajak query --iso USD --date 2024-10-21
```

The CLI prints structured summaries; all writes trigger an encrypted `pg_dump` backup before touching the database.

## HTTP Service

```bash
kurs-pajak service --host 0.0.0.0 --port 8000
```

Endpoints:

- `GET /health` – liveness probe with base URL & timezone.
- `GET /rate?date=YYYY-MM-DD&iso=USD` – returns per-unit IDR rate, normalised by the stored unit (JPY → divides by 100).
- `GET /period/latest[?date=YYYY-MM-DD]` – returns the latest (or date-containing) bulletin with the full rate table and per-unit values.

The scheduler runs within the same process, polling daily and automatically backfilling any missing historical weeks.

## Backups

1. **Encryption** – backups are encrypted with Fernet using `BACKUP_ENCRYPTION_KEY`.
2. **Destinations** – local filesystem, S3, or GCS via `BACKUP_TARGET_URL`.
3. **Retention** – files older than `BACKUP_RETENTION_DAYS` are deleted after each backup.

Restore example:

```bash
export BACKUP_ENCRYPTION_KEY=...  # same key used for backup
python - <<'PY'
import os
from cryptography.fernet import Fernet
from pathlib import Path
key = os.environ['BACKUP_ENCRYPTION_KEY'].encode()
source = Path('/path/to/kurs_pajak_20241023T010000Z.dump.enc')
Path('/tmp/kurs_pajak.dump').write_bytes(Fernet(key).decrypt(source.read_bytes()))
PY
pg_restore --clean --if-exists --dbname "$DATABASE_URL" /tmp/kurs_pajak.dump
```

## Docker & Compose

Build and run the service plus Postgres:

```bash
BACKUP_ENCRYPTION_KEY=$(openssl rand -base64 32) docker compose up kurs_pajak
```

The container exposes `8010` → `8000` with a healthcheck hitting `/health`. Compose mounts a `kurs_pajak_backups` volume for encrypted dumps.

To run a one-off load inside the container:

```bash
docker compose run --rm kurs_pajak python -m kurs_pajak.cli load --date 2024-10-16
```

## Tests & Lint

```bash
pip install -e services/kurs_pajak[dev]
pytest services/kurs_pajak/tests
```

Tests cover the HTML parser (including JPY special handling), number normalisation, and database upsert idempotency.

## Scheduler Behaviour

- Period windows are aligned to Wednesday→Tuesday using `Asia/Jakarta` dates.
- Startup backfill fetches history (bounded by `SCRAPER_MAX_PAGES`) to fill gaps.
- Each tick re-scrapes the lookback window and upserts only when data changes, ensuring idempotence.
- Any new or changed period triggers a pre-write backup.
