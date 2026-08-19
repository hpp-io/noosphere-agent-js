FROM python:3.11-slim

# espeak-ng: Kokoro/misaki G2P fallback. build-essential: mecab-python3 (MeloTTS).
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng git build-essential \
    && rm -rf /var/lib/apt/lists/*

# torch/torchaudio from the CPU index FIRST — as transitive deps they would
# pull multi-GB CUDA wheels on x86_64.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir fastapi uvicorn "kokoro>=0.9.4"

# MeloTTS after kokoro so its pins (transformers==4.27.4 et al.) win the tree;
# torch/torchaudio are already satisfied so the CPU builds stay in place.
RUN pip install --no-cache-dir git+https://github.com/myshell-ai/MeloTTS.git
# MeCab dictionary — melo imports its Japanese module regardless of language.
RUN python -m unidic download

# Bake models + curated voices so startup serves immediately and runtime
# needs no network (Kokoro-82M ~330MB, MeloTTS-Korean ~200MB, voices ~500KB ea).
RUN python -c "from kokoro import KPipeline; p = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M'); [p.load_voice(v) for v in ['af_heart', 'af_bella', 'am_adam', 'am_michael']]"
RUN python -c "from kokoro import KPipeline; p = KPipeline(lang_code='b', repo_id='hexgrad/Kokoro-82M'); [p.load_voice(v) for v in ['bf_emma', 'bm_george']]"
RUN python -c "from melo.api import TTS; TTS(language='KR', device='cpu')"

# ffmpeg for optional mp3 output. Separate late layer on purpose — folding it
# into the first apt RUN would invalidate the torch/model layers above.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY app.py .

EXPOSE 8096
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8096"]
