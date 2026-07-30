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

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
