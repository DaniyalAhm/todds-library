from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from alembic.config import Config
from alembic import command
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import router
from app.api.settings import recover_interrupted_generation_logs
from app.config import settings
from app.database import init_db
from app.services.session_service import close_redis, init_redis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_redis()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: command.upgrade(Config("alembic.ini"), "head"))
    await recover_interrupted_generation_logs()
    yield
    await close_redis()
    await app.state.engine.dispose() if hasattr(app.state, "engine") else None


def create_app() -> FastAPI:
    app = FastAPI(
        title="Todds Library",
        description="Ebook and audiobook library server",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(router, prefix="/api")

    @app.get("/health")
    async def health_check():
        return {"status": "healthy"}

    return app


app = create_app()
