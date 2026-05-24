"""Speaker diarization using Sortformer via mlx-audio.

Runs NVIDIA's Sortformer model natively on Apple Silicon (MLX/Metal).
No HF token or pyannote required. Supports up to 4 speakers.
Uses streaming state across chunks for consistent speaker IDs.
"""

import logging
import time

import numpy as np

log = logging.getLogger(__name__)


class Diarizer:
    """Sortformer-based diarization running on MLX/Metal."""

    def __init__(self, model_name="mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16"):
        self.model_name = model_name
        self.model = None
        self._state = None
        self._cumulative_seconds = 0.0
        self._stream_offset = 0.0  # where the next feed starts in stream time

    def _ensure_loaded(self):
        """Lazy-load on first use so MLX stream is on the calling thread."""
        if self.model is None:
            log.info(f"Loading diarization model: {self.model_name}")
            t0 = time.monotonic()
            from mlx_audio.vad import load
            self.model = load(self.model_name)
            self._state = self.model.init_streaming_state()
            log.info(f"Diarization model loaded in {time.monotonic() - t0:.1f}s")

    def diarize_chunk(self, pcm_int16, sample_rate=16000, overlap_samples=0, chunk_offset=0.0):
        """Run diarization on a chunk of int16 PCM audio.

        Only feeds the non-overlap portion to avoid confusing the streaming
        model with repeated audio. On the first chunk, feeds everything.

        Returns list of dicts with absolute timestamps:
            [{"speaker": int, "start": float, "end": float}, ...]
        """
        self._ensure_loaded()

        chunk_duration = len(pcm_int16) / sample_rate

        # Only feed new audio  - skip the overlap region that was already
        # processed in the previous chunk. First chunk gets everything.
        if self._cumulative_seconds > 0 and overlap_samples > 0:
            new_audio = pcm_int16[overlap_samples:]
            overlap_secs = overlap_samples / sample_rate
        else:
            new_audio = pcm_int16
            overlap_secs = 0.0

        audio_float = new_audio.astype(np.float32) / 32768.0
        fed_duration = len(audio_float) / sample_rate
        feed_start = self._cumulative_seconds

        result, self._state = self.model.feed(
            audio_float,
            self._state,
            sample_rate=sample_rate,
            threshold=0.4,
            min_duration=0.25,
            merge_gap=0.3,
        )

        self._cumulative_seconds += fed_duration
        # Where this fed audio starts in stream time
        stream_start = chunk_offset + overlap_secs
        chunk_end = chunk_offset + chunk_duration

        # Convert model-cumulative timestamps to absolute stream time
        results = []
        for seg in result.segments:
            abs_start = (seg.start - feed_start) + stream_start
            abs_end = (seg.end - feed_start) + stream_start
            # Clamp to full chunk boundaries (including overlap region)
            abs_start = max(chunk_offset, abs_start)
            abs_end = min(chunk_end, abs_end)
            if abs_end > abs_start:
                results.append({
                    "speaker": seg.speaker,
                    "start": abs_start,
                    "end": abs_end,
                })

        # Merge consecutive segments from the same speaker
        merged = []
        for seg in results:
            if merged and merged[-1]["speaker"] == seg["speaker"]:
                merged[-1]["end"] = seg["end"]
            else:
                merged.append(dict(seg))

        if merged:
            speaker_ids = set(r["speaker"] for r in merged)
            log.info(f"Diarization: {len(merged)} segments, speakers={sorted(speaker_ids)}, "
                     f"cumulative={self._cumulative_seconds:.1f}s, chunk_offset={chunk_offset:.1f}s, "
                     f"fed={fed_duration:.1f}s")
            for seg in merged:
                log.debug(f"  Speaker {seg['speaker']}: {seg['start']:.2f}s - {seg['end']:.2f}s")

        return merged

    def reset(self):
        """Reset streaming state for a new session."""
        self._cumulative_seconds = 0.0
        self._stream_offset = 0.0
        if self.model is not None:
            self._state = self.model.init_streaming_state()


def create_diarizer(config):
    """Create a Diarizer. Always available  - no HF token needed."""
    if config.get("DIARIZE", "true").lower() in ("0", "false", "no"):
        log.info("Diarization disabled via config")
        return None

    try:
        model_name = config.get(
            "DIARIZE_MODEL",
            "mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16",
        )
        return Diarizer(model_name=model_name)
    except Exception as e:
        log.warning(f"Failed to load diarization model: {e}")
        return None
