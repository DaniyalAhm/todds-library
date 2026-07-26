from __future__ import annotations

from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.id3 import APIC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.oggvorbis import OggVorbis


def parse_audio(filepath: str) -> dict:
    result = {
        "title": None,
        "author": None,
        "duration": None,
        "chapters": [],
        "description": None,
        "publisher": None,
        "language": None,
        "isbn": None,
        "asin": None,
        "cover_data": None,
    }

    try:
        audio = MutagenFile(filepath)
        if audio is None:
            return result

        # Duration
        if audio.info:
            result["duration"] = audio.info.length

        # Tags
        tags = audio.tags or {}

        # MP4/M4B tags
        if isinstance(audio, MP4):
            result["title"] = _get_tag_first(tags, "\xa9nam")
            result["author"] = _get_tag_first(tags, "\xa9ART")
            result["publisher"] = _get_tag_first(tags, "\xa9pub")
            result["description"] = _get_tag_first(tags, "\xa9cmt") or _get_tag_first(tags, "desc")
            # Chapter data from MP4
            if hasattr(audio, "chapters") and audio.chapters:
                for i, ch in enumerate(audio.chapters):
                    result["chapters"].append({
                        "index": i + 1,
                        "title": ch.get("title", f"Chapter {i + 1}"),
                        "start_position": ch.get("start_time", 0),
                    })
            # Cover art from MP4/M4B
            cover_data = _extract_mp4_cover(tags)
            if cover_data:
                result["cover_data"] = cover_data

        # FLAC tags
        elif isinstance(audio, FLAC):
            result["title"] = _get_tag_first(tags, "title")
            result["author"] = _get_tag_first(tags, "artist")
            result["description"] = _get_tag_first(tags, "description")
            result["publisher"] = _get_tag_first(tags, "organization")
            result["isbn"] = _get_tag_first(tags, "isbn")
            # Cover art from FLAC
            cover_data = _extract_flac_cover(audio)
            if cover_data:
                result["cover_data"] = cover_data

        # MP3 tags
        elif isinstance(audio, MP3):
            result["title"] = _get_tag_first(tags, "title")
            result["author"] = _get_tag_first(tags, "artist")
            result["description"] = _get_tag_first(tags, "description")
            result["publisher"] = _get_tag_first(tags, "publisher")
            result["isbn"] = _get_tag_first(tags, "isbn")
            # Cover art from MP3 (APIC frames)
            cover_data = _extract_mp3_cover(tags)
            if cover_data:
                result["cover_data"] = cover_data

        # Ogg Vorbis
        elif isinstance(audio, OggVorbis):
            result["title"] = _get_tag_first(tags, "title")
            result["author"] = _get_tag_first(tags, "artist")
            result["description"] = _get_tag_first(tags, "description")
            result["publisher"] = _get_tag_first(tags, "organization")
            # Cover art from Ogg Vorbis
            cover_data = _extract_ogg_cover(tags)
            if cover_data:
                result["cover_data"] = cover_data

        # Fallback to common tag names
        if result["title"] is None:
            result["title"] = _get_tag_first(tags, "title")
        if result["author"] is None:
            result["author"] = _get_tag_first(tags, "artist") or _get_tag_first(tags, "author")

    except Exception:
        pass

    return result


def _extract_mp4_cover(tags: dict) -> bytes | None:
    try:
        covr = tags.get("covr")
        if covr and len(covr) > 0:
            cover = covr[0]
            if hasattr(cover, "data"):
                return cover.data
            if isinstance(cover, bytes):
                return cover
    except Exception:
        pass
    return None


def _extract_flac_cover(audio: FLAC) -> bytes | None:
    try:
        if audio.pictures and len(audio.pictures) > 0:
            return audio.pictures[0].data
    except Exception:
        pass
    return None


def _extract_mp3_cover(tags: dict) -> bytes | None:
    try:
        apic_frames = tags.getall("APIC")
        if apic_frames:
            for frame in apic_frames:
                if frame.type == 3:
                    return frame.data
            return apic_frames[0].data
    except AttributeError:
        pass
    except Exception:
        pass
    return None


def _extract_ogg_cover(tags: dict) -> bytes | None:
    try:
        picture_tag = tags.get("metadata_block_picture")
        if picture_tag:
            import base64
            from mutagen.flac import Picture
            picture_data = base64.b64decode(picture_tag[0])
            pic = Picture(picture_data)
            return pic.data

        coverart = tags.get("coverart")
        if coverart:
            return coverart[0]
    except Exception:
        pass
    return None


def _get_tag_first(tags, key: str) -> str | None:
    if key in tags:
        val = tags[key]
        if isinstance(val, list):
            return str(val[0]) if val else None
        return str(val)
    return None
