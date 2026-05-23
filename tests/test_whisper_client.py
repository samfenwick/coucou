import numpy as np
from unittest.mock import AsyncMock, patch, MagicMock
import asyncio
import json
from whisper_client import WhisperClient, TranscriptionResult, deduplicate_segments


def test_build_wav_bytes():
    """WAV bytes have correct header for 16kHz 16-bit mono."""
    client = WhisperClient(
        endpoint="http://localhost/v1/audio/transcriptions",
        model="whisper-v3-turbo",
    )
    pcm = np.zeros(16000, dtype=np.int16)  # 1 second
    wav = client._build_wav(pcm)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    assert len(wav) == 44 + 32000  # 44-byte header + data


def test_deduplicate_segments_no_overlap():
    """Non-overlapping segments pass through unchanged."""
    prev = [
        TranscriptionResult(text="Hello world", start=0.0, end=1.0, words=[]),
    ]
    curr = [
        TranscriptionResult(text="How are you", start=3.0, end=4.0, words=[]),
    ]
    result = deduplicate_segments(prev, curr, overlap_seconds=2)
    assert len(result) == 1
    assert result[0].text == "How are you"


def test_deduplicate_segments_removes_overlap():
    """Segments within the overlap window that match previous text are removed."""
    prev = [
        TranscriptionResult(text="the quick brown fox", start=1.0, end=3.0, words=[]),
    ]
    curr = [
        TranscriptionResult(text="brown fox", start=0.0, end=1.0, words=[]),
        TranscriptionResult(text="jumps over", start=1.0, end=2.0, words=[]),
    ]
    result = deduplicate_segments(prev, curr, overlap_seconds=2)
    assert len(result) == 1
    assert result[0].text == "jumps over"


def test_transcription_result_offset():
    """Timestamps can be offset to absolute positions."""
    tr = TranscriptionResult(text="hello", start=1.0, end=2.0, words=[
        {"word": "hello", "start": 1.0, "end": 1.5},
    ])
    offset = tr.with_offset(10.0)
    assert offset.start == 11.0
    assert offset.end == 12.0
    assert offset.words[0]["start"] == 11.0
    assert offset.words[0]["end"] == 11.5
