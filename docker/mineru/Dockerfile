# CPU image for the MinerU 4 parse API. Upstream's image (docker/global in the
# MinerU repo) is built on vLLM and requires an NVIDIA GPU; this one runs
# anywhere. The base install has no torch on Linux, so it serves the `flash`
# tier (fast local text extraction). Build with EXTRAS=torch for the model-based
# `basic`/`standard` tiers on CPU; see docker-compose.gpu.yml for GPU.
FROM python:3.12-slim
ARG MINERU_VERSION=">=4.0.7,<5"
ARG EXTRAS=""
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "mineru${EXTRAS:+[$EXTRAS]}${MINERU_VERSION}"
# Model weights (non-flash tiers) are cached here — mount a volume so they are
# downloaded once, not on every container rebuild.
ENV HF_HOME=/models MODELSCOPE_CACHE=/models
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD curl -fsS http://localhost:8000/v1/health || exit 1
ENTRYPOINT ["mineru-kit"]
CMD ["api-server", "--host", "0.0.0.0", "--port", "8000", "--tier", "flash"]
