import os
import logging
import uvicorn

try:
    from app.utils.colored_logging import setup_colored_logging

    setup_colored_logging(logging.INFO)
except Exception:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
logger = logging.getLogger(__name__)


def main():
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", 8000))
    keep_alive = int(os.environ.get("UVICORN_TIMEOUT_KEEP_ALIVE", 30))

    if os.environ.get("DEV_MODE", "false").lower() == "true":
        logger.info("Starting development server with reload...")
        uvicorn.run(
            "app.main:app", host=host, port=port, reload=True, timeout_keep_alive=keep_alive
        )
    else:
        workers = int(os.environ.get("UVICORN_WORKERS", 4))
        logger.info("Starting production server with %s workers...", workers)
        uvicorn.run(
            "app.main:app",
            host=host,
            port=port,
            workers=workers,
            timeout_keep_alive=keep_alive,
        )


if __name__ == "__main__":
    main()
