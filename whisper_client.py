import struct
import io
import numpy as np
import httpx
from dataclasses import dataclass, field


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
                for w in self.words
            ],
        )


def deduplicate_segments(previous, current, overlap_seconds):
    """Remove segments from `current` that overlap with `previous` text.

    Segments in `current` whose start time falls within the overlap window
    AND whose text appears in the last previous segment's text are dropped.
    """
    if not previous or not current:
        return current

    prev_text = previous[-1].text.lower()
    result = []
    for seg in current:
        if seg.start < overlap_seconds:
            if seg.text.lower().strip() in prev_text:
                continue
        result.append(seg)

    return result if result else current


class WhisperClient:
    """Client for OpenAI-compatible Whisper transcription endpoint."""

    def __init__(self, endpoint, model, api_key=None, timeout=10.0):
        self.endpoint = endpoint
        self.model = model
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(timeout=timeout, headers=headers, follow_redirects=True)
        self._previous_segments = []

    def _build_wav(self, pcm_samples):
        """Build a minimal WAV file from int16 PCM samples at 16kHz mono."""
        sample_rate = 16000
        channels = 1
        bits_per_sample = 16
        data = pcm_samples.tobytes()
        data_size = len(data)

        buf = io.BytesIO()
        buf.write(b"RIFF")
        buf.write(struct.pack("<I", 36 + data_size))
        buf.write(b"WAVE")
        buf.write(b"fmt ")
        buf.write(struct.pack("<I", 16))
        buf.write(struct.pack("<H", 1))
        buf.write(struct.pack("<H", channels))
        buf.write(struct.pack("<I", sample_rate))
        buf.write(struct.pack("<I", sample_rate * channels * bits_per_sample // 8))
        buf.write(struct.pack("<H", channels * bits_per_sample // 8))
        buf.write(struct.pack("<H", bits_per_sample))
        buf.write(b"data")
        buf.write(struct.pack("<I", data_size))
        buf.write(data)

        return buf.getvalue()

    def transcribe(self, pcm_samples, chunk_offset_seconds=0.0, overlap_seconds=2):
        """Transcribe PCM samples and return deduplicated TranscriptionResults."""
        wav_data = self._build_wav(pcm_samples)

        response = self._client.post(
            self.endpoint,
            files={"file": ("audio.wav", wav_data, "audio/wav")},
            data={
                "model": self.model,
                "response_format": "verbose_json",
                "timestamp_granularities[]": "word",
            },
        )
        response.raise_for_status()
        result = response.json()

        segments = []
        for seg in result.get("segments", []):
            words = []
            for w in seg.get("words", []):
                words.append({
                    "word": w["word"],
                    "start": w["start"],
                    "end": w["end"],
                })
            segments.append(TranscriptionResult(
                text=seg["text"].strip(),
                start=seg["start"],
                end=seg["end"],
                words=words,
            ))

        deduped = deduplicate_segments(self._previous_segments, segments, overlap_seconds)
        self._previous_segments = segments

        return [s.with_offset(chunk_offset_seconds) for s in deduped]
