import numpy as np
from transcription_client import TranscriptionResult, deduplicate_segments


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
        TranscriptionResult(
            text="brown fox",
            start=0.0, end=1.5,
            words=[
                {"word": "brown", "start": 0.0, "end": 0.7},
                {"word": "fox", "start": 0.7, "end": 1.5},
            ],
        ),
        TranscriptionResult(
            text="jumps over",
            start=2.0, end=3.5,
            words=[
                {"word": "jumps", "start": 2.0, "end": 2.5},
                {"word": "over", "start": 2.5, "end": 3.5},
            ],
        ),
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
