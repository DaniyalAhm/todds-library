from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from bs4 import BeautifulSoup


def _get_opf_info(zf: zipfile.ZipFile) -> tuple[str | None, ET.Element | None, Path]:
    """Return (opf_path, opf_xml_element, opf_dir)."""
    opf_path = None
    try:
        container = zf.read("META-INF/container.xml")
        xml = ET.fromstring(container)
        ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
        rf = xml.find(".//c:rootfiles/c:rootfile", ns)
        if rf is not None:
            opf_path = rf.get("full-path")
    except Exception:
        pass
    if opf_path is None:
        for name in zf.namelist():
            if name.endswith(".opf"):
                opf_path = name
                break
    if opf_path is None:
        return None, None, Path(".")
    try:
        data = zf.read(opf_path)
        elem = ET.fromstring(data)
        return opf_path, elem, Path(opf_path).parent
    except Exception:
        return None, None, Path(".")


def _parse_ncx_titles(zf: zipfile.ZipFile, opf_xml: ET.Element, opf_dir: Path) -> list[str]:
    titles: list[str] = []
    ns = {
        "opf": "http://www.idpf.org/2007/opf",
        "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    }
    try:
        spine = opf_xml.find("opf:spine", ns)
        toc = spine.attrib.get("toc") if spine is not None else None
        if not toc:
            return titles
        manifest = opf_xml.find("opf:manifest", ns)
        if manifest is None:
            return titles
        href = None
        for item in manifest.findall("opf:item", ns):
            if item.attrib.get("id") == toc:
                href = item.attrib.get("href")
                break
        if not href:
            return titles
        ncx_path = str(opf_dir / href)
        ncx_data = zf.read(ncx_path)
        ncx_xml = ET.fromstring(ncx_data)
        nav_map = ncx_xml.find("ncx:navMap", ns)
        if nav_map is not None:
            for nav_point in nav_map.findall("ncx:navPoint", ns):
                nl = nav_point.find("ncx:navLabel/ncx:text", ns)
                txt = (nl.text or "").strip() if nl is not None else ""
                if txt:
                    titles.append(txt)
    except Exception:
        pass
    return titles


def _spine_hrefs(zf: zipfile.ZipFile, opf_xml: ET.Element, opf_dir: Path) -> list[str]:
    ns = {"opf": "http://www.idpf.org/2007/opf"}
    hrefs: list[str] = []
    try:
        manifest_map: dict[str, str] = {}
        manifest = opf_xml.find("opf:manifest", ns)
        if manifest is not None:
            for item in manifest.findall("opf:item", ns):
                mid = item.attrib.get("id")
                href = item.attrib.get("href")
                if mid and href:
                    manifest_map[mid] = href
        spine = opf_xml.find("opf:spine", ns)
        if spine is None:
            return hrefs
        for ref in spine.findall("opf:itemref", ns):
            mid = ref.attrib.get("idref")
            href = manifest_map.get(mid or "")
            if href:
                hrefs.append(str(opf_dir / href))
    except Exception:
        pass
    return hrefs


def _html_to_text(html_bytes: bytes) -> str:
    try:
        soup = BeautifulSoup(html_bytes, "lxml")
        # remove scripts/styles
        for tag in soup(["script", "style"]):
            tag.decompose()
        text = soup.get_text(separator="\n")
        # normalize whitespace but keep paragraph breaks
        text = re.sub(r"\r\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"[ \t]{2,}", " ", text)
        # strip each line
        lines = [ln.strip() for ln in text.splitlines()]
        # drop empty lines at start/end, collapse multiple blanks
        cleaned: list[str] = []
        blank = 0
        for ln in lines:
            if not ln:
                blank += 1
                if blank <= 1:
                    cleaned.append("")
                continue
            blank = 0
            cleaned.append(ln)
        return "\n".join(cleaned).strip()
    except Exception:
        # fallback: naive
        try:
            return BeautifulSoup(html_bytes, "html.parser").get_text(separator="\n").strip()
        except Exception:
            return ""


def extract_epub_chapters(epub_path: str) -> list[dict]:
    """Return ordered chapter bodies for the given EPUB.

    Each entry: {index, title, body, word_count}
    Index is 1-based spine order, excluding trivial front-matter.
    """
    path = Path(epub_path)
    if not path.is_file():
        return []

    try:
        with zipfile.ZipFile(str(path), "r") as zf:
            opf_path, opf_xml, opf_dir = _get_opf_info(zf)
            if opf_xml is None:
                return []
            hrefs = _spine_hrefs(zf, opf_xml, opf_dir)
            ncx_titles = _parse_ncx_titles(zf, opf_xml, opf_dir)

            chapters: list[dict] = []
            for idx, href in enumerate(hrefs, start=1):
                try:
                    raw = zf.read(href)
                except KeyError:
                    continue
                body = _html_to_text(raw)
                # skip empty or very short boilerplate (e.g. cover page with single word)
                if len(body.strip()) < 80:
                    # keep but mark as likely front matter; caller may filter
                    if not body.strip():
                        continue
                title = ncx_titles[idx - 1] if idx - 1 < len(ncx_titles) else Path(href).stem
                # try to improve title from first <h1/h2> if ncx missing or generic
                if idx - 1 >= len(ncx_titles) or not title or title.lower().startswith("chapter"):
                    try:
                        soup = BeautifulSoup(raw, "lxml")
                        h = soup.find(["h1", "h2", "title"])
                        if h and h.get_text(strip=True):
                            candidate = h.get_text(strip=True)
                            if 2 < len(candidate) < 120:
                                title = candidate
                    except Exception:
                        pass
                chapters.append(
                    {
                        "index": idx,
                        "title": title or f"Chapter {idx}",
                        "body": body,
                        "word_count": len(body.split()),
                        "href": href,
                    }
                )
            return chapters
    except Exception:
        return []


def get_chapter_body(epub_path: str, chapter_index: int) -> str | None:
    """Return body for a specific 1-based chapter index, or None."""
    chapters = extract_epub_chapters(epub_path)
    for ch in chapters:
        if ch["index"] == chapter_index:
            return ch["body"]
    return None
