# hf-sentiment — minimal HuggingFace model wrapped as a Noosphere compute container.
#
# The ONLY contract a sellable container must satisfy:
#   POST /computation  { "input": "<raw string>", ...parsed-json-fields }
#   -> respond { "output": "<string>" }
#
# The agent (ContainerManager) POSTs the buyer's JSON body here and returns
# `output` to the buyer. Everything else (payment, validation, settlement)
# is handled by the agent's x402 seller module.

from fastapi import FastAPI, Request
from transformers import pipeline

app = FastAPI()

# Loaded once at startup; the model is baked into the image at build time
# so this is a warm cache read, not a download.
clf = pipeline(
    "sentiment-analysis",
    model="distilbert-base-uncased-finetuned-sst-2-english",
)


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()
    # Buyer sends {"text": "..."}; the agent forwards it alongside a raw
    # `input` string. Prefer the parsed field, fall back to raw input.
    text = body.get("text") or body.get("input") or ""
    if not isinstance(text, str) or not text.strip():
        return {"output": "error: empty text"}
    result = clf(text[:2000])[0]  # cap input length defensively
    return {"output": f"{result['label']} ({result['score']:.4f})"}


@app.get("/health")
async def health():
    return {"ok": True}
