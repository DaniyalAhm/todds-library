from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings
from app.metadata.base import MetadataProvider

logger = logging.getLogger(__name__)


class RReadingGlassesProvider(MetadataProvider):
    @property
    def name(self) -> str:
        return "rreading_glasses"

    async def fetch(
        self,
        isbn: str | None = None,
        asin: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> dict:
        base_urls = self._candidate_base_urls()
        if not base_urls:
            return {}

        try:
            async with httpx.AsyncClient(timeout=20) as client:
                for base_url in base_urls:
                    edition_id = await self._resolve_edition_id(
                        client,
                        base_url,
                        isbn=isbn,
                        asin=asin,
                        title=title,
                        author=author,
                    )
                    if edition_id is None:
                        continue

                    resource = await self._fetch_resource(client, base_url, edition_id)
                    if not resource:
                        continue

                    result = self._extract(resource)
                    await self._attach_cover(client, result, resource, base_url)
                    return result
        except Exception as exc:
            logger.warning("rreading-glasses lookup failed: %s", exc)
            return {}

        return {}

    def _candidate_base_urls(self) -> list[str]:
        urls = []
        primary = settings.rreading_glasses_url.strip().rstrip("/")
        if primary:
            urls.append(primary)
        fallback = "https://api.bookinfo.pro"
        if fallback not in urls:
            urls.append(fallback)
        return urls

    def _build_query(
        self,
        isbn: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> str | None:
        if isbn:
            return isbn.strip()

        parts = [part.strip() for part in (title, author) if part and part.strip()]
        if parts:
            return " ".join(parts)
        return None

    async def _resolve_edition_id(
        self,
        client: httpx.AsyncClient,
        base_url: str,
        isbn: str | None = None,
        asin: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> int | None:
        if isbn:
            edition_id = await self._lookup_identifier(client, f"{base_url}/book/isbn/{isbn.strip()}")
            if edition_id is not None:
                return edition_id
        if asin:
            edition_id = await self._lookup_identifier(client, f"{base_url}/book/asin/{asin.strip()}")
            if edition_id is not None:
                return edition_id

        search_query = self._build_query(isbn=None, title=title, author=author)
        if not search_query:
            return None

        try:
            resp = await client.get(f"{base_url}/search", params={"q": search_query})
            if resp.status_code != 200:
                return None
            payload = resp.json()
            if isinstance(payload, list):
                for item in payload:
                    if not isinstance(item, dict):
                        continue
                    edition_id = item.get("workId") or item.get("bookId")
                    if edition_id not in (None, ""):
                        try:
                            return int(edition_id)
                        except (TypeError, ValueError):
                            continue
        except Exception as exc:
            logger.info("rreading-glasses search failed: %s", exc)
        return None

    async def _lookup_identifier(self, client: httpx.AsyncClient, url: str) -> int | None:
        try:
            resp = await client.get(url)
            if resp.status_code != 200:
                return None
            payload = resp.json()
            if payload in (None, ""):
                return None
            return int(payload)
        except Exception as exc:
            logger.info("rreading-glasses identifier lookup failed for %s: %s", url, exc)
            return None

    async def _fetch_resource(
        self,
        client: httpx.AsyncClient,
        base_url: str,
        edition_id: int,
    ) -> dict | None:
        for endpoint in (f"{base_url}/book/{edition_id}", f"{base_url}/work/{edition_id}"):
            try:
                resp = await client.get(endpoint)
                if resp.status_code == 200:
                    payload = resp.json()
                    if isinstance(payload, dict):
                        return payload
            except Exception as exc:
                logger.info("rreading-glasses resource fetch failed for %s: %s", endpoint, exc)
        return None

    def _extract(self, resource: dict) -> dict:
        book = self._best_book(resource)
        authors = resource.get("Authors")
        author = self._extract_author(authors)
        if not author:
            author = self._extract_author(book.get("Contributors") if isinstance(book, dict) else None)
        series_name, series_index = self._extract_series(resource)
        return {
            "title": self._extract_title(resource, book),
            "author": author,
            "description": self._extract_description(resource, book),
            "publisher": self._extract_publisher(resource, book),
            "published_date": self._extract_published_date(resource, book),
            "page_count": self._extract_page_count(resource, book),
            "isbn": self._extract_isbn(resource, book),
            "language": self._extract_language(resource, book),
            "series": series_name,
            "series_index": series_index,
        }

    def _best_book(self, resource: dict) -> dict:
        books = resource.get("Books")
        if isinstance(books, list):
            for book in books:
                if isinstance(book, dict):
                    return book
        return {}

    def _extract_title(self, resource: dict, book: dict) -> str | None:
        for source in (book, resource):
            for key in ("FullTitle", "Title", "ShortTitle"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return None

    def _extract_description(self, resource: dict, book: dict) -> str | None:
        for source in (book, resource):
            for key in ("Description", "description", "overview", "summary"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return None

    def _extract_publisher(self, resource: dict, book: dict) -> str | None:
        for source in (book, resource):
            for key in ("Publisher", "publisher", "publisherName"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return None

    def _extract_published_date(self, resource: dict, book: dict) -> str | None:
        for source in (book, resource):
            for key in ("ReleaseDateRaw", "ReleaseDate", "publishedDate", "releaseDate"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return None

    def _extract_page_count(self, resource: dict, book: dict) -> int | None:
        for source in (book, resource):
            for key in ("NumPages", "pageCount", "pages"):
                value = source.get(key)
                if value not in (None, ""):
                    try:
                        return int(value)
                    except (TypeError, ValueError):
                        continue
        return None

    def _extract_author(self, authors: Any) -> str | None:
        if isinstance(authors, list) and authors:
            first = authors[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
            if isinstance(first, dict):
                for key in ("Name", "name", "authorName"):
                    value = first.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()
        return None

    def _extract_series(self, resource: dict) -> tuple[str | None, float | None]:
        series = resource.get("Series")
        if isinstance(series, list) and series:
            first_series = series[0]
            if isinstance(first_series, dict):
                name = first_series.get("Title")
                series_index = None
                link_items = first_series.get("LinkItems")
                if isinstance(link_items, list) and link_items:
                    for link in link_items:
                        if not isinstance(link, dict):
                            continue
                        position = link.get("SeriesPosition")
                        if position not in (None, ""):
                            try:
                                series_index = float(position)
                                break
                            except (TypeError, ValueError):
                                continue
                return (name.strip() if isinstance(name, str) and name.strip() else None, series_index)
        return (None, None)

    def _extract_language(self, resource: dict, book: dict) -> str | None:
        value = book.get("Language") or resource.get("Language")
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
            if isinstance(first, dict):
                return first.get("name")
        return None

    def _extract_isbn(self, resource: dict, book: dict) -> str | None:
        for source in (book, resource):
            for key in ("Isbn13", "isbn13", "isbn", "isbn_13", "isbn10", "isbn_10"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
                if isinstance(value, list) and value:
                    first = value[0]
                    if isinstance(first, str) and first.strip():
                        return first.strip()

        return None

    def _extract_cover_url(self, resource: dict, base_url: str) -> str | None:
        book = self._best_book(resource)
        for source in (book, resource):
            remote_cover = source.get("remoteCover")
            if isinstance(remote_cover, str) and remote_cover.strip():
                return remote_cover.strip()

            image_url = source.get("ImageUrl")
            if isinstance(image_url, str) and image_url.strip():
                if image_url.startswith("http://") or image_url.startswith("https://"):
                    return image_url.strip()
                return f"{base_url}/{image_url.lstrip('/')}"

            image = source.get("image") or source.get("cover")
            if isinstance(image, str) and image.strip():
                if image.startswith("http://") or image.startswith("https://"):
                    return image.strip()
                return f"{base_url}/{image.lstrip('/')}"

            images = source.get("images")
            if isinstance(images, list):
                for image_item in images:
                    if not isinstance(image_item, dict):
                        continue
                    url = image_item.get("url") or image_item.get("cover")
                    if isinstance(url, str) and url.strip():
                        if url.startswith("http://") or url.startswith("https://"):
                            return url.strip()
                        return f"{base_url}/{url.lstrip('/')}"
        return None

    async def _attach_cover(
        self,
        client: httpx.AsyncClient,
        result: dict,
        resource: dict,
        base_url: str,
    ) -> None:
        cover_url = self._extract_cover_url(resource, base_url)
        if not cover_url:
            return

        try:
            resp = await client.get(cover_url)
            if resp.status_code == 200 and resp.content:
                result["cover_data"] = resp.content
        except Exception as exc:
            logger.info("rreading-glasses cover fetch failed: %s", exc)
