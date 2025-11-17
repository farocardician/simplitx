FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libpq-dev \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY docker/python/requirements-base.txt /tmp/requirements-base.txt
COPY docker/python/requirements-kurs-pajak.txt /tmp/requirements-kurs-pajak.txt
RUN pip install --upgrade pip \
    && pip install -r /tmp/requirements-base.txt \
    && pip install -r /tmp/requirements-kurs-pajak.txt

FROM deps AS development
RUN useradd -m appuser
WORKDIR /workspace
COPY services/kurs_pajak/ ./
RUN pip install -e .
USER appuser
ENV PYTHONPATH=/workspace
CMD ["python", "-m", "kurs_pajak.cli", "service"]

FROM deps AS production
WORKDIR /app
COPY services/kurs_pajak/ ./
RUN pip install .
RUN useradd -m appuser
USER appuser
ENV PYTHONPATH=/app
CMD ["python", "-m", "kurs_pajak.cli", "service"]
