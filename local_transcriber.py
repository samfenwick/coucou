"""Local Voxtral transcription using mlx-audio on Apple Silicon.

Runs the model in-process  - no external API needed.
Model is cached in ~/.cache/huggingface after first download.
Extracts word-level timestamps from token positions (each token = 80ms of audio).
"""

import io
import logging
import os
import re
import struct
import tempfile
import time

import numpy as np

log = logging.getLogger(__name__)

_model = None
_model_name = None

# Token IDs
PAD_TOKEN = 32
EOS_TOKEN = 2


def preload_model(model_name="mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit"):
    """Load model at startup so first transcription is fast."""
    global _model, _model_name
    if _model is not None and _model_name == model_name:
        return _model

    log.info(f"Loading Voxtral model: {model_name}")
    t0 = time.monotonic()
    from mlx_audio.stt.utils import load
    _model = load(model_name)
    _model_name = model_name
    log.info(f"Voxtral model loaded in {time.monotonic() - t0:.1f}s")
    return _model


def _build_wav(pcm_int16, sample_rate=16000):
    """Build a minimal WAV from int16 PCM."""
    data = pcm_int16.tobytes()
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + len(data)))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 1))          # PCM
    buf.write(struct.pack("<H", 1))          # mono
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))
    buf.write(struct.pack("<H", 2))          # block align
    buf.write(struct.pack("<H", 16))         # bits per sample
    buf.write(b"data")
    buf.write(struct.pack("<I", len(data)))
    buf.write(data)
    return buf.getvalue()


def _extract_words_from_tokens(generated, tokenizer, ms_per_token=80, delay_tokens=6):
    """Extract word-level timestamps from Voxtral's generated token list.

    Each token position corresponds to ms_per_token ms of audio.
    Pad tokens (32) = silence, text tokens = speech.
    The model has a transcription delay of delay_tokens  - a text token
    at position i describes audio at position (i - delay_tokens).
    """
    words = []
    if not generated:
        return words

    # Find runs of text tokens (non-pad, non-eos)
    text_runs = []  # list of (start_pos, [token_ids])
    current_run_start = None
    current_run_tokens = []

    for pos, tid in enumerate(generated):
        if tid not in (PAD_TOKEN, EOS_TOKEN):
            if current_run_start is None:
                current_run_start = pos
            current_run_tokens.append(tid)
        else:
            if current_run_tokens:
                text_runs.append((current_run_start, list(current_run_tokens)))
                current_run_tokens = []
                current_run_start = None

    if current_run_tokens:
        text_runs.append((current_run_start, list(current_run_tokens)))

    if not text_runs:
        return words

    # Decode each run and assign timestamps
    # Within a run, tokens map to consecutive 80ms frames
    for run_start, run_tokens in text_runs:
        # Decode the full run to get text
        run_text = tokenizer.decode(run_tokens).strip()
        if not run_text:
            continue

        # Split into words and distribute tokens proportionally
        text_words = run_text.split()
        if not text_words:
            continue

        # Try to decode token by token to find word boundaries
        token_texts = []
        for tid in run_tokens:
            token_texts.append(tokenizer.decode([tid]))

        # Map tokens to words by accumulating decoded text
        word_idx = 0
        word_start_pos = run_start
        accumulated = ""

        for i, token_text in enumerate(token_texts):
            accumulated += token_text

            # Check if we've completed the current word (next char would be space or we're at end)
            accumulated_stripped = accumulated.strip()
            if word_idx < len(text_words):
                target = text_words[word_idx]
                if accumulated_stripped.endswith(target) or i == len(token_texts) - 1:
                    word_end_pos = run_start + i + 1
                    # Subtract delay: token at pos P describes audio at (P - delay_tokens)
                    start_s = max(0, (word_start_pos - delay_tokens) * ms_per_token / 1000.0)
                    end_s = max(0, (word_end_pos - delay_tokens) * ms_per_token / 1000.0)
                    words.append({
                        "word": target,
                        "start": start_s,
                        "end": end_s,
                    })
                    word_start_pos = word_end_pos
                    word_idx += 1
                    accumulated = ""

        # Catch any remaining words
        while word_idx < len(text_words):
            pos = run_start + len(run_tokens)
            words.append({
                "word": text_words[word_idx],
                "start": max(0, (pos - delay_tokens) * ms_per_token / 1000.0),
                "end": max(0, (pos + 1 - delay_tokens) * ms_per_token / 1000.0),
            })
            word_idx += 1

    return words


SENTENCE_END_RE = re.compile(r'[.!?…]\s*$')


class StreamingTranscriber:
    """Real-time streaming transcriber using Voxtral's streaming session.

    feed() is thread-safe (called from audio capture callback).
    poll() must be called from the MLX thread to generate tokens and emit results.
    """

    def __init__(self, model_name="mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
                 delay_ms=480):
        self.model_name = model_name
        self.delay_ms = delay_ms
        self.model = preload_model(model_name)
        self._session = None
        self._prev_generated_len = 0
        self._final_token_pos = 0  # token index where last final ended
        self._samples_fed = 0  # total 16kHz samples fed
        self._silence_tokens = 0  # consecutive PAD tokens
        self._last_text_time = 0.0  # time of last text token

    def _new_session(self):
        self._session = self.model.create_streaming_session(
            transcription_delay_ms=self.delay_ms,
        )
        self._prev_generated_len = 0
        self._final_token_pos = 0
        self._silence_tokens = 0
        self._last_text_time = 0.0
        log.debug("New streaming session created")

    def feed(self, pcm_int16):
        """Feed audio samples (int16, 16kHz). Thread-safe."""
        if self._session is None:
            self._new_session()
        audio_float = pcm_int16.astype(np.float32) / 32768.0
        self._session.feed(audio_float)
        self._samples_fed += len(pcm_int16)

    def poll(self):
        """Generate tokens and return results. Must be called from MLX thread.

        Returns list of dicts:
          {"type": "partial", "text": "..."}  - live updating text
          {"type": "final", "text": "...", "start": float, "end": float}  - completed sentence
        """
        if self._session is None:
            return []

        results = []
        # Step to generate tokens  - use small batch for low latency
        deltas = self._session.step(max_decode_tokens=4)

        # Check for new tokens
        generated = self._session.generated
        new_tokens = generated[self._prev_generated_len:]
        self._prev_generated_len = len(generated)

        if not new_tokens:
            return results

        # Track silence vs text
        has_text = False
        for tid in new_tokens:
            if tid in (PAD_TOKEN, EOS_TOKEN):
                self._silence_tokens += 1
            else:
                self._silence_tokens = 0
                self._last_text_time = time.monotonic()
                has_text = True

        # Only decode tokens since last final  - avoids growing cost
        recent_tokens = [t for t in generated[self._final_token_pos:] if t not in (PAD_TOKEN, EOS_TOKEN)]
        if not recent_tokens:
            return results

        current_text = self.model._tokenizer.decode(recent_tokens).strip()
        if not current_text:
            return results

        # Check for sentence boundary, long silence, or max partial duration
        is_sentence_end = bool(SENTENCE_END_RE.search(current_text))
        is_long_silence = self._silence_tokens >= 15  # ~1.2s of silence
        word_count = len(current_text.split())
        is_long_partial = word_count >= 20  # force final if partial gets too long

        if is_sentence_end or is_long_partial or (is_long_silence and word_count >= 2):
            # Emit final
            end_time = self._samples_fed / 16000.0
            start_time = max(0, end_time - len(current_text.split()) * 0.3)  # rough estimate
            results.append({
                "type": "final",
                "text": current_text,
                "start": start_time,
                "end": end_time,
            })
            self._final_token_pos = len(generated)
            self._silence_tokens = 0
            log.debug(f"Streaming final: '{current_text[:60]}...' ({len(current_text.split())} words)")
        else:
            # Emit partial
            results.append({
                "type": "partial",
                "text": current_text,
            })

        return results

    def reset(self):
        """Reset for a new stream. Creates a fresh session."""
        if self._session is not None:
            try:
                self._session.close()
            except Exception:
                pass
        self._session = None
        self._prev_generated_len = 0
        self._final_token_pos = 0
        self._samples_fed = 0
        self._silence_tokens = 0
        self._last_text_time = 0.0


class LocalTranscriber:
    """Local Voxtral transcriber using mlx-audio on Apple Silicon."""

    def __init__(self, model_name="mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
                 delay_ms=480):
        self.model_name = model_name
        self.delay_ms = delay_ms
        self.model = preload_model(model_name)
        self._previous_segments = []

    def transcribe(self, pcm_samples, chunk_offset_seconds=0.0, overlap_seconds=2):
        """Transcribe PCM int16 samples with word-level timestamps."""
        from transcription_client import TranscriptionResult, deduplicate_segments

        wav_data = _build_wav(pcm_samples)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_data)
            wav_path = f.name

        try:
            duration = len(pcm_samples) / 16000.0

            # Use streaming session to access raw token IDs
            sess = self.model.create_streaming_session(
                transcription_delay_ms=self.delay_ms,
            )
            audio_float = pcm_samples.astype(np.float32) / 32768.0
            sess.feed(audio_float)
            sess.close()

            while not sess.done:
                sess.step(max_decode_tokens=16)

            # Extract text
            text_tokens = [t for t in sess.generated if t not in (PAD_TOKEN, EOS_TOKEN)]
            if not text_tokens:
                log.debug(f"Voxtral: no text tokens (generated {len(sess.generated)} total, all PAD/EOS)")
                self._previous_segments = []  # clear so next chunk isn't falsely deduped
                return []

            text = self.model._tokenizer.decode(text_tokens).strip()
            if not text:
                log.debug(f"Voxtral: {len(text_tokens)} text tokens decoded to empty string")
                self._previous_segments = []
                return []

            # Extract word timestamps from token positions
            delay_tokens = self.delay_ms // 80  # each token = 80ms
            words = _extract_words_from_tokens(
                sess.generated, self.model._tokenizer, delay_tokens=delay_tokens
            )

            log.debug(f"Voxtral: {len(sess.generated)} tokens, {len(words)} words, "
                      f"{len(text_tokens)} text tokens")

            segments = [TranscriptionResult(
                text=text,
                start=0.0,
                end=duration,
                words=words,
            )]
        finally:
            os.unlink(wav_path)

        deduped = deduplicate_segments(self._previous_segments, segments, overlap_seconds)
        log.debug(f"Voxtral dedup: {len(segments)} segments in, {len(deduped)} out (prev={len(self._previous_segments) if self._previous_segments else 0})")
        self._previous_segments = segments

        return [s.with_offset(chunk_offset_seconds) for s in deduped]
