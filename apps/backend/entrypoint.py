import os
import logging
import uvicorn


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", 8000))

    if os.environ.get("DEV_MODE", "false").lower() == "true":
        logger.info("Starting development server with reload...")
        uvicorn.run("app.main:app", host=host, port=port, reload=True)
    else:
        workers = int(os.environ.get("UVICORN_WORKERS", 4))
        logger.info("Starting production server with %s workers...", workers)
        uvicorn.run("app.main:app", host=host, port=port, workers=workers)


if __name__ == "__main__":
    main()
