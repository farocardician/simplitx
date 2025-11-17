# Base stage
FROM python:3.11-slim as base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies stage
FROM base AS deps
COPY docker/python/requirements-base.txt /tmp/requirements-base.txt
COPY docker/python/requirements-reranker.txt /tmp/requirements-reranker.txt
RUN pip install --upgrade pip \
    && pip install numpy>=1.24.0 \
    && pip install -r /tmp/requirements-base.txt \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch==2.2.2 \
    && pip install -r /tmp/requirements-reranker.txt

# Development stage
FROM deps AS development
RUN useradd -m appuser
USER appuser
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# Production stage
FROM deps AS production
COPY services/reranker/ ./
RUN useradd -m appuser
USER appuser
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
