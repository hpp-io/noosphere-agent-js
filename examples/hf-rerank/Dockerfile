FROM python:3.11-slim

# CPU-only torch wheel first (the default PyPI wheel drags in multi-GB CUDA
# deps on x86_64); transformers<5 pin — v5 dropped several pipeline tasks.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir fastapi uvicorn "transformers<5" sentence-transformers

# Bake the model into the image so container startup serves immediately
# (~91MB, cached under /root/.cache/huggingface).
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('cross-encoder/ms-marco-MiniLM-L6-v2')"

WORKDIR /srv
COPY app.py .

EXPOSE 8092
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8092"]
