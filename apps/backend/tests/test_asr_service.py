from __future__ import annotations

import os
import sys
import json
from types import SimpleNamespace

import pytest

from app.services import asr_service


def test_normalize_model_id_maps_existing_openai_settings() -> None:
    assert asr_service._normalize_model_id("small") == "small"
    assert asr_service._normalize_model_id("large-v3") == "large-v3"
    assert asr_service._normalize_model_id("turbo") == "turbo"
    assert asr_service._normalize_model_id("openai/whisper-small") == "small"
    assert asr_service._normalize_model_id("openai/whisper-medium") == "medium"
    assert asr_service._normalize_model_id("openai/whisper-large") == "large-v3"
    assert asr_service._normalize_model_id("openai/whisper-large-v1") == "large-v1"
    assert asr_service._normalize_model_id("openai/whisper-large-v2") == "large-v2"
    assert asr_service._normalize_model_id("openai/whisper-large-v3") == "large-v3"
    assert asr_service._normalize_model_id("openai/whisper-large-v3-turbo") == "turbo"
    assert asr_service._normalize_model_id("custom/ct2-model") == "custom/ct2-model"


def test_resolve_compute_type_uses_configured_type(monkeypatch) -> None:
    monkeypatch.setattr(asr_service.settings, "asr_compute_type", "float32")
    assert asr_service._resolve_compute_type("cuda") == "float32"

    monkeypatch.setattr(asr_service.settings, "asr_compute_type", "float16")
    assert asr_service._resolve_compute_type("cuda") == "float16"

    monkeypatch.setattr(asr_service.settings, "asr_compute_type", "bad")
    assert asr_service._resolve_compute_type("cuda") == "float32"


def test_resolve_device_index_uses_configured_cuda_gpu(monkeypatch) -> None:
    monkeypatch.setattr(asr_service.settings, "asr_gpu_index", 1)

    assert asr_service._resolve_device_index("cuda") == 1
    assert asr_service._resolve_device_index("cpu") is None


def test_get_model_pipeline_uses_configured_compute_type(monkeypatch) -> None:
    attempts = []

    class FakeWhisperModel:
        def __init__(self, model_id: str, *, device: str, device_index: int, compute_type: str, download_root: str):
            attempts.append((model_id, device, device_index, compute_type, download_root))

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel))
    monkeypatch.setattr(asr_service.settings, "asr_model_id", "small")
    monkeypatch.setattr(asr_service.settings, "asr_device", "cuda")
    monkeypatch.setattr(asr_service.settings, "asr_gpu_index", 1)
    monkeypatch.setattr(asr_service.settings, "asr_compute_type", "float32")
    monkeypatch.setattr(asr_service, "ASR_MODELS_DIR", "/models")
    asr_service.reset_model_pipeline()

    try:
        model = asr_service._get_model_pipeline()
        cached = asr_service._get_model_pipeline()

        assert isinstance(model, FakeWhisperModel)
        assert cached is model
        assert attempts == [
            ("small", "cuda", 1, "float32", "/models"),
        ]
        assert asr_service._MODEL_PIPELINE_CONFIG == ("small", "cuda", "float32", 1)
    finally:
        asr_service.reset_model_pipeline()


def test_segment_to_dict_preserves_word_timestamps() -> None:
    segment = SimpleNamespace(
        start=1.25,
        end=3.5,
        text=" Hello world",
        words=[
            SimpleNamespace(start=1.25, end=1.75, word=" Hello"),
            SimpleNamespace(start=1.8, end=3.5, word="world"),
        ],
    )

    assert asr_service._segment_to_dict(segment) == {
        "start": 1.25,
        "end": 3.5,
        "text": " Hello world",
        "words": [
            {"start": 1.25, "end": 1.75, "text": "Hello"},
            {"start": 1.8, "end": 3.5, "text": "world"},
        ],
    }


def test_transcribe_uses_faster_whisper_shape(monkeypatch) -> None:
    class FakeModel:
        def transcribe(self, audio_path: str, **kwargs):
            assert audio_path == "/tmp/chapter.mp3"
            assert kwargs["language"] == "en"
            assert kwargs["word_timestamps"] is True
            assert kwargs["chunk_length"] == 45
            assert kwargs["vad_filter"] is False
            return (
                iter(
                    [
                        SimpleNamespace(
                            start=0,
                            end=2.5,
                            text="Generated subtitle text",
                            words=[
                                SimpleNamespace(start=0, end=0.8, word="Generated"),
                                SimpleNamespace(start=0.9, end=1.7, word="subtitle"),
                                SimpleNamespace(start=1.8, end=2.5, word="text"),
                            ],
                        )
                    ]
                ),
                SimpleNamespace(language="en"),
            )

    monkeypatch.setattr(asr_service, "_get_model_pipeline", lambda: FakeModel())

    result = asr_service.transcribe(
        "/tmp/chapter.mp3",
        language="en",
        batch_size=8,
        chunk_length_s=45,
        vad_filter=False,
    )

    assert result.language == "en"
    assert result.text == "Generated subtitle text"
    assert result.cue_count == 1
    assert result.word_count == 3
    assert result.segments[0]["words"][1]["text"] == "subtitle"


def test_chunk_timestamp_offset_and_stitching() -> None:
    first = {
        "chunk_index": 1,
        "language": "en",
        "text": "First chunk",
        "segments": asr_service._offset_segments(
            [
                {
                    "start": 1.0,
                    "end": 2.0,
                    "text": " First chunk",
                    "words": [{"start": 1.0, "end": 1.5, "text": "First"}],
                }
            ],
            0.0,
        ),
    }
    second = {
        "chunk_index": 2,
        "language": "en",
        "text": "Second chunk",
        "segments": asr_service._offset_segments(
            [
                {
                    "start": 0.5,
                    "end": 1.25,
                    "text": " Second chunk",
                    "words": [{"start": 0.5, "end": 1.0, "text": "Second"}],
                }
            ],
            1800.0,
        ),
    }

    stitched = asr_service._stitch_chunk_results([second, first])

    assert stitched.text == "First chunk Second chunk"
    assert stitched.segments[0]["start"] == 1.0
    assert stitched.segments[1]["start"] == 1800.5
    assert stitched.segments[1]["words"][0]["end"] == 1801.0


def test_chunked_transcription_resumes_existing_partials(monkeypatch, tmp_path) -> None:
    output_dir = tmp_path / "subtitles"
    partial_dir = output_dir / ".partials" / "chapter_0001"
    partial_dir.mkdir(parents=True)
    (partial_dir / "chunk_000001.json").write_text(
        json.dumps(
            {
                "chunk_index": 1,
                "start_sec": 0.0,
                "end_sec": 60.0,
                "language": "en",
                "text": "Already done",
                "segments": [
                    {
                        "start": 5.0,
                        "end": 6.0,
                        "text": " Already done",
                        "words": [{"start": 5.0, "end": 6.0, "text": "Already"}],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    extract_calls = []

    def fake_extract(_audio_path: str, start_sec: float, duration_sec: float) -> str:
        extract_calls.append((start_sec, duration_sec))
        chunk_path = tmp_path / f"chunk-{int(start_sec)}.wav"
        chunk_path.write_text("audio", encoding="utf-8")
        return str(chunk_path)

    def fake_transcribe(_audio_path: str, *_args, **_kwargs) -> asr_service.TranscriptionResult:
        return asr_service.TranscriptionResult(
            text="New chunk",
            language="en",
            segments=[
                {
                    "start": 1.0,
                    "end": 2.0,
                    "text": " New chunk",
                    "words": [{"start": 1.0, "end": 2.0, "text": "New"}],
                }
            ],
        )

    progress = []
    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)
    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe)

    result = asr_service.transcribe_chapter_chunked(
        "/books/long.mp3",
        str(output_dir),
        1,
        duration_sec=120.0,
        chunk_duration_s=60,
        progress_callback=lambda *args: progress.append(args),
    )

    cues = json.loads((output_dir / "chapter_0001.json").read_text(encoding="utf-8"))["cues"]
    assert extract_calls == [(60, 60.0)]
    assert progress == [(1, 2, 0, 60.0), (2, 2, 60, 120.0)]
    assert cues[0]["start"] == 5.0
    assert cues[1]["start"] == 61.0
    assert result.cue_count == 2
    assert not partial_dir.exists()


def test_transcribe_full_source_chunks_long_sources(monkeypatch, tmp_path) -> None:
    extract_calls = []

    def fake_extract(_audio_path: str, start_sec: float, duration_sec: float) -> str:
        extract_calls.append((start_sec, duration_sec))
        chunk_path = tmp_path / f"chunk-{int(start_sec)}.wav"
        chunk_path.write_text("audio", encoding="utf-8")
        return str(chunk_path)

    def fake_transcribe(_audio_path: str, *_args, **_kwargs) -> asr_service.TranscriptionResult:
        return asr_service.TranscriptionResult(
            text="Chunk",
            language="en",
            segments=[
                {
                    "start": 1.0,
                    "end": 2.0,
                    "text": " Chunk",
                    "words": [{"start": 1.0, "end": 2.0, "text": "Chunk"}],
                }
            ],
        )

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)
    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe)

    result = asr_service.transcribe_full_source(
        "/books/long.mp3",
        duration_sec=120.0,
        chunk_duration_s=60,
    )

    assert extract_calls == [(0, 60.0), (60, 60.0)]
    assert result.segments[0]["start"] == 1.0
    assert result.segments[1]["start"] == 61.0
    assert result.cue_count == 2


def test_transcribe_full_source_skips_chunking_for_short_sources(monkeypatch) -> None:
    calls = []

    def fake_transcribe(_audio_path: str, *_args, **_kwargs):
        calls.append(_audio_path)
        return asr_service.TranscriptionResult(
            text="short",
            language="en",
            segments=[{"start": 0.0, "end": 5.0, "text": " short", "words": []}],
        )

    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe)

    result = asr_service.transcribe_full_source(
        "/books/short.mp3",
        duration_sec=10.0,
        chunk_duration_s=60,
    )
    assert calls == ["/books/short.mp3"]
    assert result.cue_count == 1


def test_result_coverage() -> None:
    result = asr_service.TranscriptionResult(
        text="",
        language="en",
        segments=[{"start": 0.0, "end": 500.0, "text": "", "words": []}],
    )
    assert asr_service._result_coverage(result, 1000.0) == 0.5
    assert asr_service._result_coverage(result, None) == 0.0
    assert asr_service._result_coverage(result, 100.0) == 1.0

    empty = asr_service.TranscriptionResult(text="", language="en", segments=[])
    assert asr_service._result_coverage(empty, 1000.0) == 0.0


def _word(start: float, end: float, text: str) -> SimpleNamespace:
    return SimpleNamespace(start=start, end=end, word=text)


def _seg(start: float, end: float, text: str) -> SimpleNamespace:
    return SimpleNamespace(
        start=start,
        end=end,
        text=text,
        words=[_word(start, end, text)],
    )


def test_transcribe_falls_back_to_ffmpeg_when_decode_truncates(monkeypatch, tmp_path) -> None:
    calls: list[str] = []

    class FakeModel:
        def transcribe(self, audio_path: str, **kwargs):
            calls.append(audio_path)
            if audio_path == "/books/corrupt.mp3":
                segments = [_seg(0.0, 100.0, "truncated")]
            else:
                segments = [
                    _seg(0.0, 50.0, "full"),
                    _seg(500.0, 980.0, "coverage"),
                ]
            return iter(segments), SimpleNamespace(language="en")

    monkeypatch.setattr(asr_service, "_get_model_pipeline", lambda: FakeModel())
    monkeypatch.setattr(asr_service, "probe_audio_duration", lambda _path: 1000.0)

    wav_path = tmp_path / "clean.wav"

    def fake_extract(_audio_path: str, _start_sec: float, _duration_sec: float) -> str:
        wav_path.write_bytes(b"RIFF")
        return str(wav_path)

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)

    result = asr_service.transcribe("/books/corrupt.mp3")

    assert calls == ["/books/corrupt.mp3", str(wav_path)]
    assert [seg["end"] for seg in result.segments] == [50.0, 980.0]
    assert not wav_path.exists()


def test_transcribe_keeps_pyav_result_when_ffmpeg_fallback_no_better(monkeypatch, tmp_path) -> None:
    class FakeModel:
        def transcribe(self, audio_path: str, **kwargs):
            if audio_path == "/books/low.mp3":
                return iter([_seg(0.0, 400.0, "partial")]), SimpleNamespace(language="en")
            return iter([_seg(0.0, 400.0, "same")]), SimpleNamespace(language="en")

    monkeypatch.setattr(asr_service, "_get_model_pipeline", lambda: FakeModel())
    monkeypatch.setattr(asr_service, "probe_audio_duration", lambda _path: 1000.0)

    wav_path = tmp_path / "clean.wav"

    def fake_extract(_audio_path: str, _start_sec: float, _duration_sec: float) -> str:
        wav_path.write_bytes(b"RIFF")
        return str(wav_path)

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)

    result = asr_service.transcribe("/books/low.mp3")

    assert result.segments[0]["text"] == "partial"
    assert not wav_path.exists()


def test_transcribe_raises_when_no_words_after_fallback(monkeypatch, tmp_path) -> None:
    class FakeModel:
        def transcribe(self, audio_path: str, **kwargs):
            return iter([]), SimpleNamespace(language="en")

    monkeypatch.setattr(asr_service, "_get_model_pipeline", lambda: FakeModel())
    monkeypatch.setattr(asr_service, "probe_audio_duration", lambda _path: 1000.0)

    wav_path = tmp_path / "clean.wav"

    def fake_extract(_audio_path: str, _start_sec: float, _duration_sec: float) -> str:
        wav_path.write_bytes(b"RIFF")
        return str(wav_path)

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)

    with pytest.raises(asr_service.ASRError, match="no words"):
        asr_service.transcribe("/books/empty.mp3")
    assert not wav_path.exists()


def test_has_leading_zero_padding_detects_padded_files(tmp_path) -> None:
    padded = tmp_path / "padded.mp3"
    padded.write_bytes(b"\x00" * 4096 + b"ID3" + b"\x00" * 100)
    assert asr_service.has_leading_zero_padding(str(padded)) is True

    clean = tmp_path / "clean.mp3"
    clean.write_bytes(b"ID3" + b"\x00" * 100)
    assert asr_service.has_leading_zero_padding(str(clean)) is False

    empty = tmp_path / "empty.mp3"
    empty.write_bytes(b"")
    assert asr_service.has_leading_zero_padding(str(empty)) is False


def test_has_leading_zero_padding_missing_file(tmp_path) -> None:
    assert asr_service.has_leading_zero_padding(str(tmp_path / "nope.mp3")) is False


def test_transcribe_sanitizes_zero_padded_source(monkeypatch, tmp_path) -> None:
    padded_source = tmp_path / "padded.mp3"
    padded_source.write_bytes(b"\x00" * 4096 + b"ID3" + b"\x00" * 100)

    calls = []

    class FakeModel:
        def transcribe(self, audio_path: str, **kwargs):
            calls.append(audio_path)
            return (
                iter(
                    [
                        _seg(0.0, 5.0, "recovered"),
                    ]
                ),
                SimpleNamespace(language="en"),
            )

    monkeypatch.setattr(asr_service, "_get_model_pipeline", lambda: FakeModel())
    monkeypatch.setattr(asr_service, "probe_audio_duration", lambda _path: 5.0)

    sanitized_wav = tmp_path / "sanitized.wav"
    sanitized_wav.write_bytes(b"RIFF" + b"\x00" * 1024)

    monkeypatch.setattr(asr_service, "sanitize_audio_to_wav", lambda _path: str(sanitized_wav))
    monkeypatch.setattr(asr_service, "_retranscribe_via_ffmpeg", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not fall back")))

    result = asr_service.transcribe(str(padded_source))

    assert calls == [str(sanitized_wav)]
    assert result.segments[0]["text"] == "recovered"
    assert not sanitized_wav.exists()


def test_transcribe_sanitize_failure_falls_through(monkeypatch, tmp_path) -> None:
    calls = []

    class FakeModel:
        def transcribe(self, audio_path: str, **kwargs):
            calls.append(audio_path)
            return (
                iter([_seg(0.0, 5.0, "raw")]),
                SimpleNamespace(language="en"),
            )

    monkeypatch.setattr(asr_service, "_get_model_pipeline", lambda: FakeModel())
    monkeypatch.setattr(asr_service, "probe_audio_duration", lambda _path: 5.0)
    monkeypatch.setattr(asr_service, "sanitize_audio_to_wav", lambda _path: None)
    monkeypatch.setattr(asr_service, "_retranscribe_via_ffmpeg", lambda *args, **kwargs: None)

    result = asr_service.transcribe("/books/padded.mp3")

    assert calls == ["/books/padded.mp3"]
    assert result.segments[0]["text"] == "raw"


def test_extract_audio_chunk_tolerates_partial_decode(monkeypatch, tmp_path) -> None:
    import subprocess

    def fake_run(cmd, **kwargs):
        out_path = cmd[-1]
        with open(out_path, "wb") as f:
            f.write(b"RIFF" + b"\x00" * 4096)
        return SimpleNamespace(returncode=69, stderr="", stdout="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    out = asr_service._extract_audio_chunk("/books/corrupt.m4b", 0.0, 1800.0)
    assert out.startswith("/tmp/")
    assert os.path.exists(out)
    assert os.path.getsize(out) > 1024


def test_extract_audio_chunk_raises_on_empty_output(monkeypatch, tmp_path) -> None:
    import subprocess

    def fake_run(cmd, **kwargs):
        out_path = cmd[-1]
        with open(out_path, "wb") as f:
            f.write(b"RIFF")
        return SimpleNamespace(returncode=69, stderr="", stdout="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(asr_service.ASRError, match="No decodable audio"):
        asr_service._extract_audio_chunk("/books/corrupt.m4b", 1800.0, 1800.0)


def test_chunked_transcription_skips_undecodable_chunks(monkeypatch, tmp_path) -> None:
    calls = []

    def fake_extract(_audio_path: str, start_sec: float, duration_sec: float) -> str:
        calls.append((start_sec, duration_sec))
        if start_sec == 0:
            chunk_path = tmp_path / "chunk-0.wav"
            chunk_path.write_text("audio", encoding="utf-8")
            return str(chunk_path)
        raise asr_service.ASRError("No decodable audio")

    def fake_transcribe(_audio_path: str, *_args, **_kwargs) -> asr_service.TranscriptionResult:
        return asr_service.TranscriptionResult(
            text="Chunk",
            language="en",
            segments=[
                {
                    "start": 1.0,
                    "end": 2.0,
                    "text": " Chunk",
                    "words": [{"start": 1.0, "end": 2.0, "text": "Chunk"}],
                }
            ],
        )

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)
    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe)

    result = asr_service.transcribe_full_source(
        "/books/corrupt.m4b",
        duration_sec=120.0,
        chunk_duration_s=60,
    )

    assert calls == [(0, 60.0), (60, 60.0)]
    assert result.segments[0]["start"] == 1.0
    assert result.cue_count == 1


def test_chunked_transcription_raises_when_no_chunks_decodable(monkeypatch, tmp_path) -> None:
    def fake_extract(_audio_path: str, _start_sec: float, _duration_sec: float) -> str:
        raise asr_service.ASRError("No decodable audio")

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)

    with pytest.raises(asr_service.ASRError, match="No decodable audio"):
        asr_service.transcribe_full_source(
            "/books/corrupt.m4b",
            duration_sec=120.0,
            chunk_duration_s=60,
        )


def test_chunked_transcription_sanitizes_source_when_fast_seek_fails(monkeypatch, tmp_path) -> None:
    sanitized_wav = tmp_path / "sanitized.wav"
    sanitized_wav.write_bytes(b"RIFF" + b"\x00" * 2048)

    extract_calls = []

    def fake_extract(audio_path: str, start_sec: float, duration_sec: float) -> str:
        extract_calls.append((audio_path, start_sec, duration_sec))
        if audio_path == "/books/corrupt.m4b":
            raise asr_service.ASRError("No decodable audio")
        chunk_path = tmp_path / f"chunk-{int(start_sec)}.wav"
        chunk_path.write_text("audio", encoding="utf-8")
        return str(chunk_path)

    def fake_sanitize(_audio_path: str) -> str:
        return str(sanitized_wav)

    def fake_transcribe(_audio_path: str, *_args, **_kwargs) -> asr_service.TranscriptionResult:
        return asr_service.TranscriptionResult(
            text="Chunk",
            language="en",
            segments=[
                {
                    "start": 1.0,
                    "end": 2.0,
                    "text": " Chunk",
                    "words": [{"start": 1.0, "end": 2.0, "text": "Chunk"}],
                }
            ],
        )

    monkeypatch.setattr(asr_service, "_extract_audio_chunk", fake_extract)
    monkeypatch.setattr(asr_service, "_sanitize_chunk_source", fake_sanitize)
    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe)

    result = asr_service.transcribe_full_source(
        "/books/corrupt.m4b",
        duration_sec=120.0,
        chunk_duration_s=60,
    )

    assert extract_calls == [
        ("/books/corrupt.m4b", 0.0, 60.0),
        (str(sanitized_wav), 0.0, 60.0),
        (str(sanitized_wav), 60.0, 60.0),
    ]
    assert result.segments[0]["start"] == 1.0
    assert result.segments[1]["start"] == 61.0
    assert result.cue_count == 2
    assert not sanitized_wav.exists()


def test_should_use_chunked_transcription_allows_multitrack(monkeypatch) -> None:
    assert asr_service.should_use_chunked_transcription(
        audio_source_count=8,
        chapter_count=8,
        audio_path="/books/long.m4b",
        duration_sec=7200.0,
    ) is True

    assert asr_service.should_use_chunked_transcription(
        audio_source_count=8,
        chapter_count=8,
        audio_path="/books/short.m4b",
        duration_sec=600.0,
    ) is False
