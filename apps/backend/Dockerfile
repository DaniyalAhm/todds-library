FROM python:3.12-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml .
COPY app/ ./app/
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch --index-url $TORCH_INDEX_URL && \
    pip install --no-cache-dir . && \
    python - <<'PY'
import importlib.metadata
import torch
import io
import wave
from faster_whisper.audio import decode_audio

# Exercise the decoder API so incompatible PyAV versions fail during build.
audio = io.BytesIO()
with wave.open(audio, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(16000)
    wav.writeframes(b"\x00\x00" * 1600)
audio.seek(0)
assert decode_audio(audio).shape == (1600,), "ASR audio decoding failed"


def version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("+", 1)[0].split(".") if part.isdigit())


cuda_version = torch.version.cuda
if cuda_version is None or version_tuple(cuda_version) < (12, 3):
    raise SystemExit(f"CUDA 12.3+ is required, found {cuda_version!r}")

cudnn_version = torch.backends.cudnn.version()
if cudnn_version is None or cudnn_version < 90000 or cudnn_version >= 100000:
    raise SystemExit(f"cuDNN 9.x is required, found {cudnn_version!r}")

ctranslate2_version = importlib.metadata.version("ctranslate2")
if version_tuple(ctranslate2_version) < (4, 5, 0):
    raise SystemExit(f"CTranslate2 >= 4.5.0 is required, found {ctranslate2_version}")

print(
    "ASR runtime verified: "
    f"ctranslate2={ctranslate2_version}, cuda={cuda_version}, cudnn={cudnn_version}"
)
PY

FROM python:3.12-slim-bookworm

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ffmpeg curl libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /app/app ./app/

ENV PYTHONUNBUFFERED=1
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.12/site-packages/nvidia/nccl/lib:${LD_LIBRARY_PATH}

COPY alembic.ini ./alembic.ini
COPY alembic/ ./alembic/
COPY entrypoint.py ./entrypoint.py

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

ENTRYPOINT ["python", "entrypoint.py"]
