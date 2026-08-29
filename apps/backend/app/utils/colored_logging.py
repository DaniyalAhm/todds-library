from __future__ import annotations

import logging
import os
from rich.logging import RichHandler
from rich.console import Console

# Category colors for rich markup
CATEGORY_STYLES = {
    "HLS": "bold cyan",
    "FS": "bold magenta",
    "AUTH": "bold blue",
    "SCANNER": "bold yellow",
    "PLAYER": "bold green",
    "ASR": "bold bright_magenta",
    "LIBRARY": "bold bright_blue",
}

def _is_color_disabled() -> bool:
    return os.getenv("NO_COLOR") == "1" or os.getenv("LOG_COLOR") == "0"

def setup_colored_logging(level: int = logging.INFO) -> None:
    """Replace basicConfig with RichHandler for colored docker logs."""
    if _is_color_disabled():
        logging.basicConfig(level=level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        return

    # Avoid duplicate handlers on reload (uvicorn reload, pytest)
    root = logging.getLogger()
    # Clear existing handlers added by prior basicConfig
    if root.handlers:
        root.handlers.clear()

    console = Console(force_terminal=True, color_system="truecolor", width=200)
    handler = RichHandler(
        console=console,
        show_time=True,
        show_path=False,
        rich_tracebacks=True,
        tracebacks_show_locals=False,
        markup=True,
        log_time_format="[%X]",
    )
    handler.setLevel(level)
    root.addHandler(handler)
    root.setLevel(level)
    # Silence uvicorn access logs to keep color clean unless needed
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

def category_markup(category: str, msg: str) -> str:
    style = CATEGORY_STYLES.get(category.upper(), "bold white")
    return f"[{style}][{category.upper()}][/{style}] {msg}"

def colored_print(category: str, msg: str, level: str = "info") -> None:
    """Convenience: print with rich color + also log at level."""
    logger = logging.getLogger("todds-library")
    text = category_markup(category, msg)
    if level == "warning":
        logger.warning(text, extra={"markup": True})
    elif level == "error":
        logger.error(text, extra={"markup": True})
    elif level == "debug":
        logger.debug(text, extra={"markup": True})
    else:
        logger.info(text, extra={"markup": True})
    # Also direct console print for cases where logger filtered
    if not logger.isEnabledFor(getattr(logging, level.upper(), logging.INFO)):
        console = Console(force_terminal=True)
        console.print(text)
