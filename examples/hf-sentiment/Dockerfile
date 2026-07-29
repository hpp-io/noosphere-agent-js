FROM python:3.11-slim

# transformers<5 pin — v5 removed several pipeline tasks (seq2seq et al.)
RUN pip install --no-cache-dir fastapi uvicorn "transformers<5" torch

# Bake the model into the image so container startup serves immediately
# (no runtime download; ~268MB, cached under /root/.cache/huggingface).
RUN python -c "from transformers import pipeline; pipeline('sentiment-analysis', model='distilbert-base-uncased-finetuned-sst-2-english')"

WORKDIR /srv
COPY app.py .

EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
