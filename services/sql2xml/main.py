"""
SQL→XML FastAPI service.

Exports tax_invoices + tax_invoice_items to XML using the same json2xml
mapping logic used by the queue page and json2xml service.
"""

from __future__ import annotations

import sys
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

# Make sure the local package is importable when running via uvicorn
SERVICE_ROOT = Path(__file__).resolve().parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from sql2xml.exporter import (  # noqa: E402
    ExportResult,
    InvoiceNotFoundError,
    InvoiceValidationError,
    export_invoices_to_xml,
)
from sql2xml.csv_exporter import (  # noqa: E402
    CsvExportResult,
    export_invoices_to_csv,
)
from sql2xml.pipeline import get_default_pipeline, load_pipeline_config  # noqa: E402
from json2xml.converter import ConversionError  # noqa: E402


class ExportRequest(BaseModel):
    invoice_ids: List[str] = Field(default_factory=list, alias="invoiceIds")
    job_id: Optional[str] = Field(None, alias="jobId")
    pipeline: Optional[str] = None
    profile: str = "default"
    mapping: Optional[str] = None
    pretty: bool = False
    params: Optional[Dict[str, Any]] = None

    model_config = {
        "populate_by_name": True,
        "extra": "ignore",
    }


app = FastAPI(
    title="SQL to XML Service",
    description="Generate XML from tax_invoices using json2xml mappings",
    version="1.0.0",
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    try:
        pipeline = get_default_pipeline()
    except RuntimeError:
        pipeline = "not configured (will use per-request pipeline)"
    return {"status": "healthy", "service": "sql2xml", "pipeline": pipeline}


def _to_http_exception(exc: Exception) -> HTTPException:
    if isinstance(exc, InvoiceValidationError):
        return HTTPException(
            status_code=400,
            detail={
                "code": exc.code,
                "message": str(exc),
                "invoices": exc.invoices,
            },
        )
    if isinstance(exc, InvoiceNotFoundError):
        return HTTPException(
            status_code=404,
            detail={"code": "NOT_FOUND", "message": str(exc)},
        )
    if isinstance(exc, FileNotFoundError):
        return HTTPException(
            status_code=404,
            detail={"code": "MAPPING_NOT_FOUND", "message": str(exc)},
        )
    if isinstance(exc, ConversionError):
        return HTTPException(
            status_code=422,
            detail={"code": "CONVERSION_ERROR", "message": str(exc)},
        )
    return HTTPException(
        status_code=500,
        detail={"code": "INTERNAL_ERROR", "message": str(exc)},
    )


def _build_response(result: ExportResult) -> Response:
    headers = {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": f'attachment; filename="{result.suggested_filename}"',
    }
    return Response(content=result.xml_bytes, media_type="application/xml", headers=headers)


def _build_zip_response(
    xml_result: ExportResult,
    csv_result: CsvExportResult,
    invoice_count: int,
) -> Response:
    """Build ZIP response containing both XML and CSV files."""
    # Create ZIP in memory
    zip_buffer = BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        # Add XML file
        zip_file.writestr(xml_result.suggested_filename, xml_result.xml_bytes)
        # Add CSV file
        zip_file.writestr(csv_result.suggested_filename, csv_result.csv_bytes)

    zip_bytes = zip_buffer.getvalue()

    # Build filename
    if invoice_count == 1:
        # For single invoice, use invoice number
        invoice_num = xml_result.invoice_numbers[0] if xml_result.invoice_numbers else "invoice"
        filename = f"{invoice_num}.zip"
    else:
        # For multiple invoices
        filename = f"invoices_{invoice_count}.zip"

    headers = {
        "Content-Type": "application/zip",
        "Content-Disposition": f'attachment; filename="{filename}"',
    }
    return Response(content=zip_bytes, media_type="application/zip", headers=headers)


@app.post("/export")
async def export_xml(req: ExportRequest):
    """Generate XML for one or many invoices.

    If sql2csv.enabled is true in the pipeline config, generates both XML and CSV
    and returns them packaged in a ZIP file. Otherwise, returns XML only.
    """
    if not req.invoice_ids and not req.job_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_REQUEST", "message": "Provide invoiceIds or jobId"},
        )

    try:
        # Load pipeline config to check if CSV is enabled
        pipeline_config, _ = load_pipeline_config(req.pipeline)
        csv_enabled = pipeline_config.get("sql2csv", {}).get("enabled", False)

        # Always generate XML
        xml_result = export_invoices_to_xml(
            invoice_ids=req.invoice_ids,
            job_id=req.job_id,
            mapping_override=req.mapping,
            pipeline=req.pipeline,
            profile=req.profile,
            pretty=req.pretty,
            params=req.params,
        )

        # If CSV not enabled, return XML only (backward compatible)
        if not csv_enabled:
            return _build_response(xml_result)

        # CSV is enabled - generate CSV as well
        csv_result = export_invoices_to_csv(
            invoice_ids=req.invoice_ids,
            job_id=req.job_id,
            pipeline=req.pipeline,
        )

        # Package both XML and CSV in a ZIP file
        invoice_count = len(req.invoice_ids) if req.invoice_ids else len(xml_result.invoice_numbers)
        return _build_zip_response(xml_result, csv_result, invoice_count)

    except Exception as exc:  # Map to structured HTTP errors
        raise _to_http_exception(exc)
