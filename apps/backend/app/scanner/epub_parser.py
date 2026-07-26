from __future__ import annotations

import io
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image


def parse_epub(filepath: str) -> dict:
    result = {
        "title": None,
        "author": None,
        "description": None,
        "cover_data": None,
        "chapters": [],
        "page_count": None,
        "publisher": None,
        "published_date": None,
        "language": None,
        "isbn": None,
    }

    try:
        with zipfile.ZipFile(filepath, "r") as zf:
            # Find OPF file
            opf_path = None
            try:
                container = zf.read("META-INF/container.xml")
                container_xml = ET.fromstring(container)
                ns = {
                    "c": "urn:oasis:names:tc:opendocument:xmlns:container"
                }
                rootfile = container_xml.find(
                    ".//c:rootfiles/c:rootfile", ns
                )
                if rootfile is not None:
                    opf_path = rootfile.get("full-path")
            except Exception:
                pass

            if opf_path is None:
                for name in zf.namelist():
                    if name.endswith(".opf"):
                        opf_path = name
                        break

            if opf_path is None:
                return result

            opf_data = zf.read(opf_path)
            opf_dir = Path(opf_path).parent

            # Parse OPF
            opf_xml = ET.fromstring(opf_data)
            ns = {
                "opf": "http://www.idpf.org/2007/opf",
                "dc": "http://purl.org/dc/elements/1.1/",
            }

            # Metadata
            metadata_elem = opf_xml.find("opf:metadata", ns)
            if metadata_elem is None:
                metadata_elem = opf_xml.find("{http://www.idpf.org/2007/opf}metadata")

            if metadata_elem is not None:
                for child in metadata_elem:
                    tag = child.tag
                    text = child.text or ""
                    if "title" in tag.lower():
                        if result["title"] is None:
                            result["title"] = text
                    elif "creator" in tag.lower():
                        if result["author"] is None:
                            result["author"] = text
                    elif "description" in tag.lower():
                        if result["description"] is None:
                            result["description"] = text
                    elif "publisher" in tag.lower():
                        if result["publisher"] is None:
                            result["publisher"] = text
                    elif "date" in tag.lower():
                        if result["published_date"] is None:
                            result["published_date"] = text
                    elif "language" in tag.lower():
                        if result["language"] is None:
                            result["language"] = text
                    elif "identifier" in tag.lower():
                        attrs = child.attrib
                        scheme = attrs.get(
                            "{http://www.idpf.org/2007/opf}scheme", ""
                        ).lower()
                        if "isbn" in scheme or "isbn" in text.lower():
                            result["isbn"] = text

            # Cover image
            cover_id = None
            for child in metadata_elem or []:
                if child.tag.endswith("meta"):
                    name = child.attrib.get("name", "")
                    if name.lower() == "cover":
                        cover_id = child.attrib.get("content")
                        break

            if cover_id is None:
                # Try to find cover in manifest
                manifest = opf_xml.find("opf:manifest", ns)
                if manifest is not None:
                    for item in manifest.findall("opf:item", ns):
                        href = item.attrib.get("href", "").lower()
                        if "cover" in href:
                            cover_id = item.attrib.get("id")
                            break

            if cover_id:
                manifest = opf_xml.find("opf:manifest", ns)
                if manifest is not None:
                    for item in manifest.findall("opf:item", ns):
                        if item.attrib.get("id") == cover_id:
                            cover_href = item.attrib.get("href")
                            if cover_href:
                                cover_path = str(opf_dir / cover_href)
                                try:
                                    cover_data = zf.read(cover_path)
                                    # Validate it's an image
                                    img = Image.open(io.BytesIO(cover_data))
                                    img.verify()
                                    result["cover_data"] = cover_data
                                except Exception:
                                    pass
                            break

            # Try NCX for chapters
            spine = opf_xml.find("opf:spine", ns)
            if spine is not None:
                toc = spine.attrib.get("toc")
                if toc:
                    manifest = opf_xml.find("opf:manifest", ns)
                    if manifest is not None:
                        for item in manifest.findall("opf:item", ns):
                            if item.attrib.get("id") == toc:
                                ncx_href = item.attrib.get("href")
                                if ncx_href:
                                    ncx_path = str(opf_dir / ncx_href)
                                    try:
                                        ncx_data = zf.read(ncx_path)
                                        result["chapters"] = _parse_ncx(ncx_data)
                                    except Exception:
                                        pass
                                break

            # Count pages by counting HTML files in spine
            if spine is not None:
                spine_items = spine.findall("opf:itemref", ns)
                if spine_items:
                    result["page_count"] = len(spine_items)

    except Exception:
        pass

    return result


def _parse_ncx(ncx_data: bytes) -> list[dict]:
    chapters = []
    try:
        ncx_xml = ET.fromstring(ncx_data)
        ns = {
            "ncx": "http://www.daisy.org/z3986/2005/ncx/",
        }
        nav_map = ncx_xml.find("ncx:navMap", ns)
        if nav_map is not None:
            for i, nav_point in enumerate(nav_map.findall("ncx:navPoint", ns)):
                nav_label = nav_point.find("ncx:navLabel/ncx:text", ns)
                title = nav_label.text if nav_label is not None else f"Chapter {i + 1}"
                content = nav_point.find("ncx:content", ns)
                src = content.attrib.get("src", "") if content is not None else ""
                chapters.append({
                    "index": i + 1,
                    "title": title,
                    "start_position": i,
                })
    except Exception:
        pass
    return chapters
