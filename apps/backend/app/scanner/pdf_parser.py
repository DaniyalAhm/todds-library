from __future__ import annotations

import fitz  # PyMuPDF


def parse_pdf(filepath: str) -> dict:
    result = {
        "title": None,
        "author": None,
        "page_count": None,
        "description": None,
        "publisher": None,
        "subject": None,
        "language": None,
    }

    try:
        doc = fitz.open(filepath)
        metadata = doc.metadata
        result["title"] = metadata.get("title")
        result["author"] = metadata.get("author")
        result["page_count"] = doc.page_count
        result["description"] = metadata.get("subject")
        result["language"] = doc.language if hasattr(doc, "language") else None
        result["publisher"] = metadata.get("publisher")

        # Try to extract first page as cover
        if doc.page_count > 0:
            page = doc[0]
            pix = page.get_pixmap(dpi=150)
            img_data = pix.tobytes("jpeg")
            result["cover_data"] = img_data

        doc.close()
    except Exception:
        pass

    return result
