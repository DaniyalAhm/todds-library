from __future__ import annotations

import sys
import json
from types import SimpleNamespace

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
