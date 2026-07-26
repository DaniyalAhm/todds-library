from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/todds-library-e2e-books")
    book_dir = root / "Mixed Author" / "Dual Format Book"
    chapters_dir = book_dir / "Chapters"
    chapters_dir.mkdir(parents=True, exist_ok=True)

    write_epub(book_dir / "Dual Format Book.epub")
    write_audio(chapters_dir / "01 - Opening.ogg")


def write_epub(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        epub.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
""",
        )
        epub.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">dual-format-book</dc:identifier>
    <dc:title>Dual Format Book</dc:title>
    <dc:creator>Mixed Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>
""",
        )
        epub.writestr(
            "OEBPS/nav.xhtml",
            """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Dual Format Book</title></head>
  <body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Opening</a></li></ol></nav></body>
</html>
""",
        )
        epub.writestr(
            "OEBPS/chapter1.xhtml",
            """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Opening</title></head>
  <body><h1>Opening</h1><p>This book exists as both an ebook and an audiobook.</p></body>
</html>
""",
        )


def write_audio(path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-c:a",
            "libvorbis",
            "-y",
            str(path),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
