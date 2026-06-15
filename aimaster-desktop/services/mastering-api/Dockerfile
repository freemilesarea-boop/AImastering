# Build context must be the monorepo's aimaster-desktop/ dir so both
# services/python-audio (engine) and services/mastering-api (this) are copied.
FROM python:3.11-slim

# ffmpeg + ffprobe (engine requires them; pin handled by the base distro —
# verify version parity with the desktop bundle, ffmpeg 7.x, in production).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY services/python-audio /srv/python-audio
COPY services/mastering-api /srv/mastering-api

ENV ENGINE_DIR=/srv/python-audio
RUN pip install --no-cache-dir -r /srv/mastering-api/requirements.txt \
    && pip install --no-cache-dir -r /srv/python-audio/requirements.txt

WORKDIR /srv/mastering-api
EXPOSE 8080
# Render injects $PORT; default 8080 for local docker run.
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
