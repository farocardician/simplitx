FROM python:3.11-slim as base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Install PDF processing system dependencies
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ghostscript \
    poppler-utils \
    tesseract-ocr \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgl1 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install base requirements first for better caching
COPY docker/python/requirements-base.txt /tmp/requirements-base.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements-base.txt

# Install worker-specific requirements
COPY docker/python/requirements-worker.txt /tmp/requirements-worker.txt
RUN pip install -r /tmp/requirements-worker.txt

# Create app user
RUN useradd -m appuser
USER appuser

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]