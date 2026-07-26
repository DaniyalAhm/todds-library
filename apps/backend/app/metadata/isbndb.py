from __future__ import annotations

import os

import httpx

from app.metadata.base import MetadataProvider


class ISBNdbProvider(MetadataProvider):
    @property
    def name(self) -> str:
        return "isbndb"

    async def fetch(
        self,
        isbn: str | None = None,
        asin: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> dict:
        api_key = os.getenv("ISBN_DB_API_KEY", "")
        if not api_key or not isbn:
            return {}

        result = {}
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"https://api.isbndb.com/book/{isbn}",
                    headers={"Authorization": api_key},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    book = data.get("book", {})
                    result = self._extract(book)
                    cover_url = self._extract_cover_url(book)
                    if cover_url:
                        await self._attach_cover(client, result, cover_url)
        except Exception:
            pass

        return result

    def _extract(self, book: dict) -> dict:
        return {
            "title": book.get("title"),
            "author": book.get("authors")[0] if book.get("authors") else None,
            "description": book.get("synopsis") or book.get("overview"),
            "publisher": book.get("publisher"),
            "published_date": book.get("date_published"),
            "page_count": book.get("pages"),
            "language": book.get("language"),
            "isbn": book.get("isbn13") or book.get("isbn"),
        }

    def _extract_cover_url(self, book: dict) -> str | None:
        image = book.get("image")
        if isinstance(image, str) and image.strip():
            if image.startswith("http://") or image.startswith("https://"):
                return image.strip()
        return None

    async def _attach_cover(
        self, client: httpx.AsyncClient, result: dict, cover_url: str
    ) -> None:
        try:
            resp = await client.get(cover_url, timeout=10)
            if resp.status_code == 200 and resp.content:
                result["cover_data"] = resp.content
        except Exception as exc:
            import logging
            logging.getLogger(__name__).info("isbndb cover fetch failed: %s", exc)
