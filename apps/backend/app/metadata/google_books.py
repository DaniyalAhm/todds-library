from __future__ import annotations

import os

import httpx

from app.config import settings
from app.metadata.base import MetadataProvider


class GoogleBooksProvider(MetadataProvider):
    @property
    def name(self) -> str:
        return "google_books"

    async def fetch(
        self,
        isbn: str | None = None,
        asin: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> dict:
        api_key = os.getenv("GOOGLE_BOOKS_API_KEY", "")
        if not api_key:
            return {}

        result = {}
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                query_parts = []
                if isbn:
                    query_parts.append(f"isbn:{isbn}")
                if title:
                    query_parts.append(f"intitle:{title}")
                if author:
                    query_parts.append(f"inauthor:{author}")

                if not query_parts:
                    return result

                query = "+".join(query_parts)
                resp = await client.get(
                    "https://www.googleapis.com/books/v1/volumes",
                    params={"q": query, "key": api_key, "maxResults": 1},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    items = data.get("items", [])
                    if items:
                        volume = items[0].get("volumeInfo", {})
                        result = self._extract(volume)

                        # Get description from longer text
                        if "description" in volume:
                            result["description"] = volume["description"]

                        # Get cover image
                        image_links = volume.get("imageLinks", {})
                        if image_links.get("thumbnail"):
                            try:
                                img_resp = await client.get(
                                    image_links["thumbnail"].replace("&edge=curl", ""),
                                    timeout=10,
                                )
                                if img_resp.status_code == 200:
                                    result["cover_data"] = img_resp.content
                            except Exception:
                                pass
        except Exception:
            pass

        return result

    def _extract(self, volume: dict) -> dict:
        return {
            "title": volume.get("title"),
            "author": ", ".join(volume.get("authors", [])) if volume.get("authors") else None,
            "description": volume.get("description"),
            "publisher": volume.get("publisher"),
            "published_date": volume.get("publishedDate"),
            "page_count": volume.get("pageCount"),
            "language": volume.get("language"),
            "isbn": self._get_isbn(volume),
        }

    def _get_isbn(self, volume: dict) -> str | None:
        identifiers = volume.get("industryIdentifiers", [])
        for ident in identifiers:
            if ident.get("type") in ("ISBN_13", "ISBN_10"):
                return ident.get("identifier")
        return None
