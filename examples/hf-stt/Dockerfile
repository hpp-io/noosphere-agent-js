FROM python:3.11-slim

# ffmpeg: decode buyer uploads (wav/mp3/m4a/ogg/webm) to 16kHz mono wav.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper is CTranslate2-based — no torch needed (keeps the image small;
# the CUDA-by-default pip torch trap does not apply here).
RUN pip install --no-cache-dir fastapi uvicorn faster-whisper

# Bake the model into the image so container startup serves immediately
# (no runtime download; Systran/faster-whisper-small ~460MB under /root/.cache).
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

WORKDIR /srv
COPY app.py .

EXPOSE 8095
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8095"]
