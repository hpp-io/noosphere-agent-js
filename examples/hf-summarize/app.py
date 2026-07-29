# hf-summarize — abstractive summarizer (sshleifer/distilbart-cnn-6-6) as a
# Noosphere compute container.
#
# Contract: POST /computation { "input": "<raw string>", ...parsed-json-fields }
#           -> { "output": "<string>" }
#
# Buyer sends {"text": "..."}; returns a few-sentence English summary.

from fastapi import FastAPI, Request
from transformers import pipeline

app = FastAPI()

# Loaded once at startup; the model is baked into the image at build time.
summarizer = pipeline("summarization", model="sshleifer/distilbart-cnn-6-6")


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()
    text = body.get("text") or body.get("input") or ""
    if not isinstance(text, str) or len(text.strip()) < 20:
        return {"output": "error: text must be at least 20 characters"}
    result = summarizer(
        text[:6000], max_length=150, min_length=20, truncation=True
    )[0]
    return {"output": result["summary_text"].strip()}


@app.get("/health")
async def health():
    return {"ok": True}
