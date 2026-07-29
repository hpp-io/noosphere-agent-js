FROM python:3.11-slim

# CPU-only torch wheel first (the default PyPI wheel drags in multi-GB CUDA
# deps on x86_64); transformers<5 pin — v5 dropped several pipeline tasks.
# sentencepiece + protobuf are required by the DeBERTa-v3 tokenizer.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir fastapi uvicorn "transformers<5" sentencepiece protobuf

# Bake the model into the image so container startup serves immediately
# (~738MB, cached under /root/.cache/huggingface).
RUN python -c "from transformers import pipeline; pipeline('text-classification', model='protectai/deberta-v3-base-prompt-injection-v2')"

WORKDIR /srv
COPY app.py .

EXPOSE 8093
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8093"]
