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
# Upstream hard-codes the pipeline's batch multiplier (formula recognition runs
# 16 × BATCH_RATIO crops at once), which overruns a small GPU sharing memory
# with vLLM. Read it from MINERU_BATCH_RATIO instead, upstream's 2 by default;
# the build fails if upstream moves the constant.
RUN f="$(python -c 'import mineru.backend.analysis.pdf.constants as c; print(c.__file__)')" \
    && grep -q '^BATCH_RATIO = 2$' "$f" \
    && sed -i 's/^BATCH_RATIO = 2$/BATCH_RATIO = int(__import__("os").environ.get("MINERU_BATCH_RATIO") or 2)/' "$f"
# vLLM's Triton kernels are compiled at engine start-up, so the model-based
# extras need a C toolchain; the flash-only image doesn't.
RUN if [ -n "$EXTRAS" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential \
      && rm -rf /var/lib/apt/lists/*; \
    fi
# Model weights (non-flash tiers) are cached here — mount a volume so they are
# downloaded once, not on every container rebuild.
ENV HF_HOME=/models MODELSCOPE_CACHE=/models \
    # MinerU 4 keeps its weights under MINERU_HOME (default ~/.mineru), not HF_HOME.
    MINERU_HOME=/models/mineru \
    # vLLM's torch.compile cache: makes GPU restarts skip most of the warm-up.
    VLLM_CACHE_ROOT=/models/vllm
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD curl -fsS http://localhost:8000/v1/health || exit 1
ENTRYPOINT ["mineru-kit"]
CMD ["api-server", "--host", "0.0.0.0", "--port", "8000", "--tier", "flash"]
