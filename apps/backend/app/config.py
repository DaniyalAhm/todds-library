from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://todds:todds_secret@localhost:5432/todds_library"
    redis_url: str = "redis://localhost:6379/0"
    meili_url: str = "http://localhost:7700"
    meili_master_key: str = ""
    authentik_issuer: str = ""
    authentik_client_id: str = ""
    authentik_client_secret: str = ""
    rreading_glasses_url: str = ""
    access_token_ttl: int = 900
    session_ttl_days: int = 30
    books_dir: str = "/books"
    covers_dir: str = "/data/covers"
    secret_key: str = "change-me-to-a-real-secret"
    cors_origins: list[str] = ["http://localhost:3000"]
    asr_model_id: str = "small"
    asr_models_dir: str = "/data/asr_models"
    asr_device: str = "auto"
    asr_gpu_index: int = 0
    asr_compute_type: str = "float32"
    subtitle_gen_mode: str = "manual"
    auto_gen_language: str = "auto"
    batch_size: int = 1
    chunk_length_s: int = 30
    vad_filter: bool = False
    # ── Castwright (host-mode) ────────────────────────────────────────────
    castwright_url: str = "http://host.docker.internal:9990"
    castwright_enabled: bool = True
    ollama_url: str = "http://localhost:11434"
    generated_audio_dir: str = ""  # empty => per-book folder alongside ebook (scanner-visible)
    castwright_timeout_s: int = 300

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


settings = Settings()
