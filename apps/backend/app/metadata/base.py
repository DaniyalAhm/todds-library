from __future__ import annotations

from abc import ABC, abstractmethod


class MetadataProvider(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    async def fetch(
        self,
        isbn: str | None = None,
        asin: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> dict:
        pass
