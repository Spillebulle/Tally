# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the React frontend
# ---------------------------------------------------------------------------
# Pinned to BUILDPLATFORM: the output is static JS/CSS with no architecture of
# its own, so building it natively rather than under QEMU keeps the arm64 image
# fast to produce and avoids npm resolving platform-specific optional
# dependencies (esbuild, rollup) for an emulated target.
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend

WORKDIR /build

# Copy manifests first so the dependency layer is cached across source edits.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Python dependencies
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS deps

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# build-essential is needed to compile a couple of wheels on arm64; it stays in
# this stage and never reaches the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install -r /tmp/requirements.txt

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini gosu \
    && rm -rf /var/lib/apt/lists/* \
    # Tally runs as this user, but the entrypoint remaps it to PUID/PGID at
    # startup so it can write to a bind-mounted /data owned by the host user.
    && groupadd -g 1000 tally \
    && useradd -u 1000 -g tally -d /app -s /usr/sbin/nologin tally

COPY --from=deps /opt/venv /opt/venv

WORKDIR /app
COPY backend/app ./app
COPY --from=frontend /build/dist ./app/static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R tally:tally /data /app

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# tini reaps the child processes uvicorn and the scheduler leave behind.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn app.main:app --host ${HOST} --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
