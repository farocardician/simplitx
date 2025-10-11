"""FlagEmbedding-powered reranker microservice.

Provides a simple JSON API compatible with the RAG pipeline's reranking needs.
"""

from __future__ import annotations

import logging
import math
import os
import threading
from typing import List, Optional, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, validator

from FlagEmbedding import FlagReranker


logger = logging.getLogger("reranker")


class Candidate(BaseModel):
    """Structured representation of a rerank candidate."""

    id: Union[int, str]
    text: str

    @validator("text")
    def _validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("candidate text must be non-empty")
        return value


class RerankRequest(BaseModel):
    """Payload accepted by the reranker endpoint."""

    query: str
    candidates: List[Candidate]
    top_k: Optional[int] = None
    model: Optional[str] = None
    normalize_scores: bool = True

    @validator("query")
    def _validate_query(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("query must be non-empty")
        return value


class ScoredCandidate(BaseModel):
    """Candidate with an attached relevance score."""

    id: Union[int, str]
    score: float
    raw_score: float


class RerankResponse(BaseModel):
    """Response returned from the reranker endpoint."""

    model: str
    results: List[ScoredCandidate]
    best: Optional[ScoredCandidate]


MODEL_ALIAS = os.getenv("RERANKER_MODEL", "bge-reranker-v2-m3")
MODEL_DEVICE = os.getenv("RERANKER_DEVICE", "cpu")
FORCE_FP16 = os.getenv("RERANKER_USE_FP16")
MODEL_ALIASES = {
    "bge-reranker-v2-m3": "BAAI/bge-reranker-v2-m3",
    "BAAI/bge-reranker-v2-m3": "BAAI/bge-reranker-v2-m3",
}

ACTIVE_MODEL_ALIAS = MODEL_ALIAS
ACTIVE_MODEL_ID = MODEL_ALIASES.get(MODEL_ALIAS, MODEL_ALIAS)
USE_FP16 = FORCE_FP16.lower() in {"1", "true", "yes"} if FORCE_FP16 else MODEL_DEVICE != "cpu"

_app_lock = threading.Lock()
_reranker: Optional[FlagReranker] = None

app = FastAPI(
    title="FlagEmbedding Reranker",
    description="Expose FlagEmbedding models behind a lightweight JSON API",
    version="0.1.0",
)


def _load_reranker() -> FlagReranker:
    global _reranker
    if _reranker is not None:
        return _reranker
    with _app_lock:
        if _reranker is None:
            logger.info("Loading reranker model '%s' on device '%s' (fp16=%s)", ACTIVE_MODEL_ID, MODEL_DEVICE, USE_FP16)
            _reranker = FlagReranker(ACTIVE_MODEL_ID, use_fp16=USE_FP16, device=MODEL_DEVICE)
    return _reranker


def _sigmoid(value: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-value))
    except OverflowError:
        return 0.0 if value < 0 else 1.0


def _score_candidates(query: str, candidates: List[Candidate], top_k: Optional[int], normalize: bool) -> List[ScoredCandidate]:
    reranker = _load_reranker()
    limit = top_k if top_k is not None and top_k > 0 else len(candidates)
    limit = min(limit, len(candidates))
    scored: List[ScoredCandidate] = []

    # Prepare pairs for batch processing
    pairs = [[query, candidate.text] for candidate in candidates[:limit]]

    try:
        # Try batch scoring first
        scores = reranker.compute_score(pairs)
        if isinstance(scores, list):
            for i, candidate in enumerate(candidates[:limit]):
                raw = float(scores[i])
                score = _sigmoid(raw) if normalize else raw
                scored.append(ScoredCandidate(id=candidate.id, score=score, raw_score=raw))
        else:
            # Fallback to single score
            raw = float(scores)
            score = _sigmoid(raw) if normalize else raw
            scored.append(ScoredCandidate(id=candidates[0].id, score=score, raw_score=raw))
    except Exception as e:
        logger.error("Batch scoring failed: %s", e)
        # Fallback to individual scoring
        for candidate in candidates[:limit]:
            try:
                raw = float(reranker.compute_score([query, candidate.text]))
                score = _sigmoid(raw) if normalize else raw
                scored.append(ScoredCandidate(id=candidate.id, score=score, raw_score=raw))
            except Exception as e2:
                logger.error("Individual scoring failed for candidate %s: %s", candidate.id, e2)
                # Add a default low score
                scored.append(ScoredCandidate(id=candidate.id, score=0.0, raw_score=-10.0))

    return scored


@app.get("/health")
def health() -> dict:
    """Health check endpoint."""

    return {"status": "ok", "model": ACTIVE_MODEL_ID}


@app.post("/rerank", response_model=RerankResponse)
def rerank(payload: RerankRequest) -> RerankResponse:
    """Return the best candidate according to the FlagEmbedding reranker."""

    if not payload.candidates:
        raise HTTPException(status_code=400, detail="candidates list must not be empty")

    requested_model = payload.model or ACTIVE_MODEL_ALIAS
    normalized_model = MODEL_ALIASES.get(requested_model, requested_model)
    if normalized_model != ACTIVE_MODEL_ID:
        raise HTTPException(
            status_code=400,
            detail=f"Model '{payload.model}' not available; loaded model is '{ACTIVE_MODEL_ALIAS}'",
        )

    scored = _score_candidates(payload.query, payload.candidates, payload.top_k, payload.normalize_scores)
    best: Optional[ScoredCandidate] = None
    if scored:
        best = max(scored, key=lambda item: item.score)

    return RerankResponse(model=ACTIVE_MODEL_ALIAS, results=scored, best=best)
