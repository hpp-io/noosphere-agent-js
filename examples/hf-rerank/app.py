# hf-rerank — cross-encoder reranker (ms-marco-MiniLM-L6-v2) as a Noosphere
# compute container.
#
# Contract: POST /computation { "input": "<raw string>", ...parsed-json-fields }
#           -> { "output": "<string>" }
#
# Buyer sends {"query": "...", "documents": ["...", ...]}; returns a JSON
# string with documents scored and ranked by relevance to the query.

import json

from fastapi import FastAPI, Request
from sentence_transformers import CrossEncoder

app = FastAPI()

# Loaded once at startup; the model is baked into the image at build time.
model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2")


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()
    query = body.get("query") or ""
    documents = body.get("documents")
    if not isinstance(query, str) or not query.strip():
        return {"output": "error: empty query"}
    if (
        not isinstance(documents, list)
        or not documents
        or not all(isinstance(d, str) and d.strip() for d in documents)
    ):
        return {"output": "error: documents must be a non-empty array of strings"}
    docs = [d[:2000] for d in documents[:32]]
    scores = model.predict([(query[:1000], d) for d in docs])
    ranked = sorted(
        ({"index": i, "score": round(float(s), 6)} for i, s in enumerate(scores)),
        key=lambda r: r["score"],
        reverse=True,
    )
    return {
        "output": json.dumps({"model": "ms-marco-MiniLM-L6-v2", "results": ranked})
    }


@app.get("/health")
async def health():
    return {"ok": True}
