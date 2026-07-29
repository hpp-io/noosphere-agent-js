# hf-promptguard — prompt-injection detector
# (protectai/deberta-v3-base-prompt-injection-v2) as a Noosphere compute
# container.
#
# Contract: POST /computation { "input": "<raw string>", ...parsed-json-fields }
#           -> { "output": "<string>" }
#
# Buyer sends {"text": "..."}; returns a JSON string with label
# SAFE|INJECTION and the classifier confidence. Classifier output is a
# signal, not a guarantee — false positives/negatives exist.

import json

from fastapi import FastAPI, Request
from transformers import pipeline

app = FastAPI()

# Loaded once at startup; the model is baked into the image at build time.
clf = pipeline(
    "text-classification",
    model="protectai/deberta-v3-base-prompt-injection-v2",
    truncation=True,
    max_length=512,
)


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()
    text = body.get("text") or body.get("input") or ""
    if not isinstance(text, str) or not text.strip():
        return {"output": "error: empty text"}
    result = clf(text[:4000])[0]
    return {
        "output": json.dumps(
            {"label": result["label"], "score": round(float(result["score"]), 6)}
        )
    }


@app.get("/health")
async def health():
    return {"ok": True}
