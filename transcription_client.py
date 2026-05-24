"""Shared transcription types and utilities."""

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass
class TranscriptionResult:
    text: str
    start: float
    end: float
    words: list[dict]

    def with_offset(self, offset_seconds):
        """Return a copy with timestamps shifted by offset_seconds."""
        return TranscriptionResult(
            text=self.text,
            start=self.start + offset_seconds,
            end=self.end + offset_seconds,
            words=[
                {**w, "start": w["start"] + offset_seconds, "end": w["end"] + offset_seconds}
                for w in (self.words or [])
            ],
        )


def deduplicate_segments(previous, current, overlap_seconds):
    """Remove overlapping content from `current` using two passes:

    1. Timestamp trim: drop segments/words before overlap_seconds (the overlap
       exists for transcriber context, not to re-transcribe).
    2. Text dedup: drop segments whose text already appeared in `previous`,
       catching cases where the model re-generates the same content at shifted
       timestamps across chunk boundaries.
    """
    if not previous or not current:
        return current

    # Pass 1: timestamp trim
    trimmed = []
    for seg in current:
        if seg.end <= overlap_seconds:
            continue
        if seg.start < overlap_seconds:
            trimmed_words = [w for w in (seg.words or []) if w["start"] >= overlap_seconds]
            if trimmed_words:
                trimmed.append(TranscriptionResult(
                    text=" ".join(w["word"] for w in trimmed_words),
                    start=trimmed_words[0]["start"],
                    end=seg.end,
                    words=trimmed_words,
                ))
            continue
        trimmed.append(seg)

    if not trimmed:
        return current

    # Pass 2: text dedup  - build a set of phrases from previous transcription
    prev_text = " ".join(seg.text.lower().strip() for seg in previous)
    result = []
    for seg in trimmed:
        seg_lower = seg.text.lower().strip()
        # Skip if this exact segment text appeared in the previous chunk
        if seg_lower and seg_lower in prev_text:
            log.debug("Text dedup dropped: %s", seg.text)
            continue
        result.append(seg)

    return result if result else trimmed
