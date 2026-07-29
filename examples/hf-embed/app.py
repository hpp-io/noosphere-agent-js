# hf-embed — sentence embeddings (all-MiniLM-L6-v2) as a Noosphere compute container.
#
# Contract: POST /computation { "input": "<raw string>", ...parsed-json-fields }
#           -> { "output": "<string>" }
#
# Buyer sends {"text": "..."}; returns a JSON string with a 384-dim
# normalized embedding vector (cosine-ready).

import json

from fastapi import FastAPI, Request
from sentence_transformers import SentenceTransformer

app = FastAPI()

# Loaded once at startup; the model is baked into the image at build time.
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()
    text = body.get("text") or body.get("input") or ""
    if not isinstance(text, str) or not text.strip():
        return {"output": "error: empty text"}
    vec = model.encode(text[:5000], normalize_embeddings=True)
    return {
        "output": json.dumps(
            {
                "model": "all-MiniLM-L6-v2",
                "dim": len(vec),
                "embedding": [round(float(x), 6) for x in vec],
            }
        )
    }


@app.get("/health")
async def health():
    return {"ok": True}
