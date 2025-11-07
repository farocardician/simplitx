"""Database backup orchestration."""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from cryptography.fernet import Fernet

from .logging import get_logger

logger = get_logger(__name__)


@dataclass(slots=True)
class BackupResult:
    location: str
    created_at: datetime


class BackupManager:
    def __init__(
        self,
        dsn: str,
        target_url: Optional[str],
        encryption_key: Optional[str],
        retention_days: int,
        enabled: bool = True,
    ) -> None:
        self.dsn = dsn
        self.enabled = enabled and bool(target_url)
        self.retention_days = retention_days
        self.target_url = target_url
        if self.enabled and not encryption_key:
            raise ValueError("BACKUP_ENCRYPTION_KEY must be provided when backups are enabled")
        self._fernet = Fernet(encryption_key) if encryption_key else None

    def backup(self, reason: str) -> Optional[BackupResult]:
        if not self.enabled:
            logger.info("backup_skipped", reason=reason)
            return None

        timestamp = datetime.now(timezone.utc)
        filename = f"kurs_pajak_{timestamp.strftime('%Y%m%dT%H%M%SZ')}.dump"

        with tempfile.TemporaryDirectory() as tmpdir:
            dump_path = Path(tmpdir) / filename
            self._run_pg_dump(dump_path)
            encrypted = self._encrypt_dump(dump_path)
            location = self._persist(encrypted, filename + ".enc")
            self._enforce_retention()
            logger.info("backup_done", location=location, reason=reason)
            return BackupResult(location=location, created_at=timestamp)

    def _run_pg_dump(self, dump_path: Path) -> None:
        command = [
            "pg_dump",
            "--no-owner",
            "--format=custom",
            f"--file={dump_path}",
            f"--dbname={self.dsn}",
        ]
        try:
            subprocess.run(command, check=True, capture_output=True)
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.decode() if exc.stderr else ""
            raise RuntimeError(f"pg_dump failed: {stderr}") from exc

    def _encrypt_dump(self, dump_path: Path) -> bytes:
        if not self._fernet:
            data = dump_path.read_bytes()
            return data
        plaintext = dump_path.read_bytes()
        return self._fernet.encrypt(plaintext)

    def _persist(self, payload: bytes, filename: str) -> str:
        assert self.target_url
        parsed = urlparse(self.target_url)
        scheme = parsed.scheme or "file"

        if scheme in {"file", ""}:
            directory = Path(parsed.path or self.target_url)
            directory.mkdir(parents=True, exist_ok=True)
            target_path = directory / filename
            target_path.write_bytes(payload)
            return str(target_path)
        if scheme == "s3":
            return self._persist_s3(parsed, payload, filename)
        if scheme in {"gcs", "gs"}:
            return self._persist_gcs(parsed, payload, filename)
        raise ValueError(f"Unsupported backup target scheme: {scheme}")

    def _persist_s3(self, parsed, payload: bytes, filename: str) -> str:
        import boto3  # type: ignore

        bucket = parsed.netloc
        prefix = parsed.path.lstrip("/")
        key = f"{prefix}/{filename}" if prefix else filename
        client = boto3.client("s3")
        client.put_object(Bucket=bucket, Key=key, Body=payload)
        return f"s3://{bucket}/{key}"

    def _persist_gcs(self, parsed, payload: bytes, filename: str) -> str:
        from google.cloud import storage  # type: ignore

        bucket_name = parsed.netloc
        prefix = parsed.path.lstrip("/")
        blob_name = f"{prefix}/{filename}" if prefix else filename
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        blob.upload_from_string(payload)
        return f"gs://{bucket_name}/{blob_name}"

    def _enforce_retention(self) -> None:
        if not self.target_url:
            return
        parsed = urlparse(self.target_url)
        scheme = parsed.scheme or "file"
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.retention_days)

        if scheme in {"file", ""}:
            directory = Path(parsed.path or self.target_url)
            if not directory.exists():
                return
            for path in sorted(directory.glob("kurs_pajak_*.dump.enc")):
                if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
                    try:
                        path.unlink()
                        logger.info("backup_retention_deleted", path=str(path))
                    except FileNotFoundError:  # pragma: no cover
                        pass
            return

        if scheme == "s3":
            import boto3  # type: ignore

            bucket = parsed.netloc
            prefix = parsed.path.lstrip("/")
            client = boto3.client("s3")
            continuation = None
            while True:
                kwargs = {"Bucket": bucket, "Prefix": prefix}
                if continuation:
                    kwargs["ContinuationToken"] = continuation
                response = client.list_objects_v2(**kwargs)
                contents = response.get("Contents", [])
                for obj in contents:
                    last_modified = obj.get("LastModified")
                    if last_modified and last_modified.tzinfo is None:
                        last_modified = last_modified.replace(tzinfo=timezone.utc)
                    if last_modified and last_modified < cutoff:
                        key = obj["Key"]
                        client.delete_object(Bucket=bucket, Key=key)
                        logger.info("backup_retention_deleted", key=f"s3://{bucket}/{key}")
                if not response.get("IsTruncated"):
                    break
                continuation = response.get("NextContinuationToken")
            return

        if scheme in {"gcs", "gs"}:
            from google.cloud import storage  # type: ignore

            bucket_name = parsed.netloc
            prefix = parsed.path.lstrip("/")
            client = storage.Client()
            bucket = client.bucket(bucket_name)
            for blob in bucket.list_blobs(prefix=prefix):
                updated = blob.updated
                if updated and updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
                if updated and updated < cutoff:
                    blob.delete()
                    logger.info("backup_retention_deleted", key=f"gs://{bucket_name}/{blob.name}")

    def restore_command(self, backup_path: str) -> str:
        """Return a documented command snippet to restore from a backup file."""
        encrypted_hint = " (encrypted)" if self._fernet else ""
        return (
            "# Restore command\n"
            f"python - <<'PY'\n"
            "import os\n"
            "from cryptography.fernet import Fernet\n"
            "from pathlib import Path\n"
            f"key = os.environ['BACKUP_ENCRYPTION_KEY'].encode()\n"
            f"data = Path('{backup_path}').read_bytes()\n"
            "Path('/tmp/kurs_pajak.dump').write_bytes(Fernet(key).decrypt(data))\n"
            "PY\n"
            "pg_restore --clean --if-exists --dbname $DATABASE_URL /tmp/kurs_pajak.dump"
        )
