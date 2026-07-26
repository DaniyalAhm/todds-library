from __future__ import annotations

import logging

import httpx
from lxml import html

from app.metadata.base import MetadataProvider

logger = logging.getLogger(__name__)


class AudibleProvider(MetadataProvider):
    @property
    def name(self) -> str:
        return "audible"

    async def fetch(
        self,
        isbn: str | None = None,
        asin: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> dict:
        result = {}

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                if asin:
                    logger.info("audible lookup by asin=%s", asin)
                    result = await self._lookup_asin(client, asin)
                elif isbn:
                    logger.info("audible search by isbn=%s", isbn)
                    result = await self._search_isbn(client, isbn)
                elif title:
                    logger.info("audible search by title='%s' author='%s'", title, author)
                    result = await self._search_title_author(client, title, author)

                if result.get("asin") and not asin:
                    logger.info("audible re-fetch by asin=%s for chapter info", result["asin"])
                    lookup = await self._lookup_asin(client, result["asin"])
                    if lookup:
                        result = lookup
                        logger.info("audible re-fetch succeeded, chapters=%s", bool(lookup.get("chapters")))
                    else:
                        logger.warning("audible re-fetch by asin returned empty")

                if result.get("cover_url"):
                    await self._attach_cover(client, result)
        except Exception as exc:
            logger.error("audible fetch failed: %s", exc)

        logger.info(
            "audible fetch result: title=%s asin=%s has_chapters=%s has_cover=%s",
            result.get("title"),
            result.get("asin"),
            bool(result.get("chapters")),
            bool(result.get("cover_data")),
        )
        return result

    async def _lookup_asin(self, client: httpx.AsyncClient, asin: str) -> dict:
        try:
            resp = await client.get(
                f"https://api.audible.com/1.0/catalog/products/{asin}",
                params={
                    "response_groups": "product_desc,product_attrs,contributors,series,chapter_info",
                },
                headers={"Accept": "application/json"},
            )
            if resp.status_code == 200:
                data = resp.json().get("product", {})
                return self._extract_product(data)
            logger.warning("audible lookup by asin returned status %s", resp.status_code)
        except Exception as exc:
            logger.error("audible lookup by asin failed: %s", exc)

        # Fallback: scrape HTML
        try:
            resp = await client.get(
                f"https://www.audible.com/pd/{asin}",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            if resp.status_code == 200:
                return self._scrape_html(resp.text)
            logger.warning("audible html fallback for %s returned status %s", asin, resp.status_code)
        except Exception as exc:
            logger.error("audible html fallback for %s failed: %s", asin, exc)

        return {}

    async def _search_isbn(self, client: httpx.AsyncClient, isbn: str) -> dict:
        try:
            resp = await client.get(
                "https://api.audible.com/1.0/catalog/products",
                params={
                    "keywords": isbn,
                    "response_groups": "product_desc,product_attrs,contributors,chapter_info",
                    "num_results": 1,
                },
            )
            if resp.status_code == 200:
                products = resp.json().get("products", [])
                if products:
                    return self._extract_product(products[0])
        except Exception:
            pass
        return {}

    async def _search_title_author(
        self, client: httpx.AsyncClient, title: str | None, author: str | None
    ) -> dict:
        keywords = f"{title} {author}" if title and author else (title or "")
        try:
            resp = await client.get(
                "https://api.audible.com/1.0/catalog/products",
                params={
                    "keywords": keywords,
                    "response_groups": "product_desc,product_attrs,contributors,chapter_info",
                    "num_results": 1,
                },
            )
            if resp.status_code == 200:
                products = resp.json().get("products", [])
                if products:
                    return self._extract_product(products[0])
        except Exception:
            pass
        return {}

    def _extract_product(self, product: dict) -> dict:
        authors = product.get("authors", []) or product.get("contributors", [])
        author_name = None
        if authors:
            author_name = authors[0].get("name") if isinstance(authors[0], dict) else str(authors[0])

        series_info = product.get("series", [])
        series_name = None
        series_sequence = None
        if series_info:
            series_name = series_info[0].get("title")
            series_sequence = series_info[0].get("sequence")

        chapters = None
        chapter_info = product.get("chapter_info") or {}
        raw_chapters = chapter_info.get("chapters")
        if raw_chapters:
            chapters = []
            for ch in raw_chapters:
                start_ms = ch.get("start_offset_ms", 0)
                length_ms = ch.get("length_ms", 0)
                chapters.append({
                    "title": ch.get("title", ""),
                    "start_offset_ms": start_ms,
                    "end_offset_ms": start_ms + length_ms,
                })

        cover_url = self._extract_cover_url(product)

        return {
            "title": product.get("title"),
            "author": author_name,
            "description": product.get("product_description") or product.get("publisher_summary"),
            "publisher": product.get("publisher_name") or product.get("publisher"),
            "published_date": product.get("publication_date") or product.get("release_date"),
            "duration": product.get("runtime_length_min", 0) * 60 if product.get("runtime_length_min") else None,
            "asin": product.get("asin"),
            "series": series_name,
            "series_index": float(series_sequence) if series_sequence else None,
            "language": product.get("language"),
            "chapters": chapters,
            "cover_url": cover_url,
        }

    def _extract_cover_url(self, product: dict) -> str | None:
        product_images = product.get("product_images") or {}
        for size in ("1212", "500", "360"):
            url = product_images.get(size)
            if isinstance(url, str) and url.strip():
                return url.strip()

        for key in ("image_url", "image", "cover"):
            url = product.get(key)
            if isinstance(url, str) and url.strip():
                if url.startswith("http://") or url.startswith("https://"):
                    return url.strip()

        return None

    async def _attach_cover(
        self, client: httpx.AsyncClient, result: dict
    ) -> None:
        cover_url = result.get("cover_url")
        if not cover_url:
            return
        try:
            resp = await client.get(cover_url, timeout=10)
            if resp.status_code == 200 and resp.content:
                result["cover_data"] = resp.content
        except Exception as exc:
            logger.info("audible cover fetch failed: %s", exc)

    def _scrape_html(self, html_content: str) -> dict:
        result = {}
        try:
            tree = html.fromstring(html_content)

            title_elem = tree.xpath("//h1[contains(@class, 'product-title')]")
            if title_elem:
                result["title"] = title_elem[0].text_content().strip()

            author_elem = tree.xpath("//li[contains(@class, 'author')]//a")
            if author_elem:
                result["author"] = author_elem[0].text_content().strip()

            desc_elem = tree.xpath("//div[contains(@class, 'product-description')]//span")
            if desc_elem:
                result["description"] = desc_elem[0].text_content().strip()

            runtime_elem = tree.xpath("//li[contains(@class, 'runtime')]")
            if runtime_elem:
                runtime_text = runtime_elem[0].text_content().strip()
                import re
                match = re.search(r"(\d+)\s*hrs?\s*(\d+)\s*min", runtime_text)
                if match:
                    result["duration"] = int(match.group(1)) * 3600 + int(match.group(2)) * 60

            og_image = tree.xpath("//meta[@property='og:image']/@content")
            if og_image:
                result["cover_url"] = og_image[0].strip()

            if not result.get("cover_url"):
                img_elem = tree.xpath("//img[contains(@class, 'product-image') or contains(@alt, 'Cover')]/@src")
                if img_elem:
                    result["cover_url"] = img_elem[0].strip()
        except Exception:
            pass
        return result
