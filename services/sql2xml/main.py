"""
SQL→XML FastAPI service.

Exports tax_invoices + tax_invoice_items to XML using the same json2xml
mapping logic used by the queue page and json2xml service.
"""

from __future__ import annotations

import sys
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
from sql2xml.pipeline import DEFAULT_PIPELINE  # noqa: E402
from json2xml.converter import ConversionError  # noqa: E402


class ExportRequest(BaseModel):
    invoice_ids: List[str] = Field(default_factory=list, alias="invoiceIds")
    batch_id: Optional[str] = Field(None, alias="batchId")
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
    return {"status": "healthy", "service": "sql2xml", "pipeline": DEFAULT_PIPELINE}


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


@app.post("/export")
async def export_xml(req: ExportRequest):
    """Generate XML for one or many invoices."""
    if not req.invoice_ids and not req.batch_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_REQUEST", "message": "Provide invoiceIds or batchId"},
        )

    try:
        result = export_invoices_to_xml(
            invoice_ids=req.invoice_ids,
            batch_id=req.batch_id,
            mapping_override=req.mapping,
            pipeline=req.pipeline,
            profile=req.profile,
            pretty=req.pretty,
            params=req.params,
        )
        return _build_response(result)
    except Exception as exc:  # Map to structured HTTP errors
        raise _to_http_exception(exc)
