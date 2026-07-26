from __future__ import annotations

import httpx

from app.metadata.base import MetadataProvider


class OpenLibraryProvider(MetadataProvider):
    @property
    def name(self) -> str:
        return "openlibrary"

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
                if isbn:
                    resp = await client.get(
                        f"https://openlibrary.org/isbn/{isbn}.json"
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        result = self._extract(data)
                        await self._attach_cover(client, result, data)

                if not result and (title or author):
                    query_parts = []
                    if title:
                        query_parts.append(f"title:{title}")
                    if author:
                        query_parts.append(f"author:{author}")
                    query = " AND ".join(query_parts)
                    resp = await client.get(
                        "https://openlibrary.org/search.json",
                        params={"q": query, "limit": 1},
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        docs = data.get("docs", [])
                        if docs:
                            result = self._extract_from_doc(docs[0])
                            await self._attach_cover(client, result, docs[0])

                            # Fetch full work details
                            work_key = docs[0].get("key")
                            if work_key:
                                try:
                                    work_resp = await client.get(
                                        f"https://openlibrary.org{work_key}.json"
                                    )
                                    if work_resp.status_code == 200:
                                        work_data = work_resp.json()
                                        if "description" in work_data:
                                            desc = work_data["description"]
                                            result["description"] = (
                                                desc
                                                if isinstance(desc, str)
                                                else desc.get("value", "")
                                            )
                                except Exception:
                                    pass
        except Exception:
            pass

        return result

    async def _attach_cover(
        self, client: httpx.AsyncClient, result: dict, source: dict
    ) -> None:
        cover_id = source.get("cover_i")
        if not cover_id:
            covers = source.get("covers")
            if isinstance(covers, list) and covers:
                cover_id = covers[0]
        if not cover_id:
            return
        try:
            resp = await client.get(f"https://covers.openlibrary.org/b/id/{cover_id}-L.jpg")
            if resp.status_code == 200 and resp.content:
                result["cover_data"] = resp.content
        except Exception:
            pass

    def _extract(self, data: dict) -> dict:
        return {
            "title": data.get("title"),
            "author": self._get_author(data),
            "description": None,
            "publisher": self._get_publisher(data),
            "published_date": data.get("publish_date") or data.get("first_publish_date"),
            "page_count": data.get("number_of_pages"),
            "isbn": data.get("isbn_13", [None])[0] if data.get("isbn_13") else None,
            "language": data.get("language", [None])[0] if isinstance(data.get("language"), list) else data.get("language"),
        }

    def _extract_from_doc(self, doc: dict) -> dict:
        return {
            "title": doc.get("title"),
            "author": doc.get("author_name", [None])[0] if doc.get("author_name") else None,
            "description": None,
            "publisher": doc.get("publisher", [None])[0] if doc.get("publisher") else None,
            "published_date": doc.get("first_publish_year"),
            "page_count": doc.get("number_of_pages_median"),
            "isbn": doc.get("isbn", [None])[0] if doc.get("isbn") else None,
            "language": doc.get("language", [None])[0] if doc.get("language") else None,
        }

    def _get_author(self, data: dict) -> str | None:
        authors = data.get("authors")
        if authors:
            for a in authors:
                if isinstance(a, dict):
                    return a.get("name") or a.get("key", "").split("/")[-1]
        return None

    def _get_publisher(self, data: dict) -> str | None:
        publishers = data.get("publishers")
        if publishers:
            if isinstance(publishers, list):
                return publishers[0] if isinstance(publishers[0], str) else publishers[0].get("name")
            return str(publishers)
        return None
