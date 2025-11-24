"""
XLS to SQL import service.

This service provides endpoints to import XLS/XLSX files into PostgreSQL
using the Sensient data pipeline.

Endpoints:
- GET /health — Health check
"""

from fastapi import FastAPI

app = FastAPI(
    title="XLS to SQL Service",
    description="Import XLS/XLSX files into PostgreSQL",
    version="1.0.0"
)


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "xls2sql"}
