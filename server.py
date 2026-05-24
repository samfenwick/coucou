import asyncio
import json
import os
import logging
import threading
import time

import numpy as np
import websockets
from websockets.asyncio.server import serve

from buffer import RingBuffer
from local_transcriber import LocalTranscriber, StreamingTranscriber, preload_model
from encoder import AudioEncoder
from audio_capture import AudioCapture
from diarize import create_diarizer
from translator import create_translator

log_level = os.environ.get("LOGLEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, log_level, logging.INFO), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)

logging.getLogger("websockets").setLevel(logging.CRITICAL)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def load_config():
    """Load configuration from .env file."""
    config = {
        "PORT": "8000",
        "HOST": "0.0.0.0",
        "ADMIN_PORT": "8001",
        "BUFFER_SECONDS": "30",
        "CHUNK_SECONDS": "10",
        "OVERLAP_SECONDS": "2",
    }
    env_path = os.path.join(os.path.dirname(__file__) or ".", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    config[key.strip()] = value.strip()
    return config


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

MODE_PRESETS = {
    "synced": {
        "chunk_seconds": 10,
        "overlap_seconds": 2,
        "translate_enabled": True,
        "diarize_enabled": True,
        "broadcast_audio": True,
        "audio_delay": 15.0,
    },
    "realtime": {
        "chunk_seconds": 2,
        "overlap_seconds": 1,
        "translate_enabled": True,
        "diarize_enabled": False,
        "broadcast_audio": True,
        "audio_delay": 0.15,
    },
}






async def handle_http(connection, request):
    """Serve static files from the static/ directory. Return None for WebSocket upgrades."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    static_dir = os.path.join(os.path.dirname(__file__) or ".", "static")
    path = request.path

    if path == "/":
        path = "/index.html"

    file_path = os.path.join(static_dir, path.lstrip("/"))
    file_path = os.path.realpath(file_path)

    if not file_path.startswith(os.path.realpath(static_dir)):
        return websockets.http11.Response(403, "Forbidden", websockets.datastructures.Headers(), b"Forbidden")

    if not os.path.isfile(file_path):
        return websockets.http11.Response(404, "Not Found", websockets.datastructures.Headers(), b"Not Found")

    ext = os.path.splitext(file_path)[1]
    content_type = CONTENT_TYPES.get(ext, "application/octet-stream")

    with open(file_path, "rb") as f:
        body = f.read()

    headers = {"Content-Type": content_type, "Cache-Control": "no-cache, no-store, must-revalidate"}
    return websockets.http11.Response(200, "OK", websockets.datastructures.Headers(headers), body)


async def handle_http_admin(connection, request):
    """Serve static files from the static/admin/ directory. Return None for WebSocket upgrades."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    static_dir = os.path.join(os.path.dirname(__file__) or ".", "static", "admin")
    path = request.path

    if path == "/":
        path = "/index.html"

    file_path = os.path.join(static_dir, path.lstrip("/"))
    file_path = os.path.realpath(file_path)

    if not file_path.startswith(os.path.realpath(static_dir)):
        return websockets.http11.Response(403, "Forbidden", websockets.datastructures.Headers(), b"Forbidden")

    if not os.path.isfile(file_path):
        return websockets.http11.Response(404, "Not Found", websockets.datastructures.Headers(), b"Not Found")

    ext = os.path.splitext(file_path)[1]
    content_type = CONTENT_TYPES.get(ext, "application/octet-stream")

    with open(file_path, "rb") as f:
        body = f.read()

    headers = {"Content-Type": content_type, "Cache-Control": "no-cache, no-store, must-revalidate"}
    return websockets.http11.Response(200, "OK", websockets.datastructures.Headers(headers), body)


connected_clients = set()
active_clients = set()  # clients that are receiving audio/subtitles
admin_clients = set()
client_state = {}  # websocket -> {"target_language": "en"}

# --- Settings persistence ---

SETTINGS_FILE = os.path.join(os.path.dirname(__file__) or ".", ".settings.json")
SETTINGS_DEFAULTS = {
    "chunk_seconds": 10,
    "overlap_seconds": 2,
    "mode": "synced",
    "audio_source": "system",
    "mic_device": None,
    "broadcast_audio": True,
    "translate_enabled": True,
    "diarize_enabled": True,
}


def load_settings():
    """Load persisted settings, falling back to defaults."""
    settings = dict(SETTINGS_DEFAULTS)
    try:
        with open(SETTINGS_FILE) as f:
            settings.update(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return settings


def save_settings():
    """Persist current tunable settings to disk."""
    data = {k: pipeline[k] for k in SETTINGS_DEFAULTS}
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(data, f)
    except OSError as e:
        log.warning(f"Failed to save settings: {e}")


saved = load_settings()

# --- Pipeline state ---
pipeline = {
    "running": False,
    "playback_buffer": None,  # 48kHz for audio streaming
    "transcription_buffer": None,   # 16kHz for transcription
    "audio_capture": None,
    "transcriber": None,
    "audio_encoder": None,
    "subtitle_queue": asyncio.Queue(),
    "diarizer": None,
    "translator": None,
    "transcription_thread": None,
    "loop": None,
    "original_output_device": None,
    "audio_delay": MODE_PRESETS.get(saved.get("mode", "synced"), {}).get("audio_delay", 15.0),
    "chunk_seconds": saved["chunk_seconds"],
    "overlap_seconds": saved["overlap_seconds"],
    # Admin / pipeline control state
    "mode": saved.get("mode", "synced"),
    "audio_source": saved.get("audio_source", "system"),
    "mic_device": saved.get("mic_device"),
    "broadcast_audio": saved.get("broadcast_audio", True),
    "translate_enabled": saved.get("translate_enabled", True),
    "diarize_enabled": saved.get("diarize_enabled", True),
    "default_target_language": "en",
    "stats": {},
    "status": "stopped",  # stopped | buffering | capturing
}


def _enqueue_subtitle(item):
    """Thread-safe enqueue: schedule put_nowait on the event loop."""
    loop = pipeline.get("loop")
    if loop:
        loop.call_soon_threadsafe(pipeline["subtitle_queue"].put_nowait, item)
    else:
        log.warning("Cannot enqueue subtitle — event loop not set!")


def _tag_words_with_speakers(words, speaker_segments):
    """Assign a speaker ID to each word based on diarization segments.

    Both words and speaker_segments use absolute timestamps.
    """
    if not speaker_segments:
        return

    # Single speaker — tag all words with that speaker
    unique_speakers = set(seg["speaker"] for seg in speaker_segments)
    if len(unique_speakers) <= 1:
        spk = next(iter(unique_speakers))
        for word in words:
            word["speaker"] = spk
        return

    tagged = 0
    for word in words:
        best_speaker = None
        best_overlap = 0
        best_distance = float("inf")
        w_start = word["start"]
        w_end = word["end"]
        w_mid = (w_start + w_end) / 2
        for seg in speaker_segments:
            # Calculate actual overlap between word and segment
            overlap = min(w_end, seg["end"]) - max(w_start, seg["start"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = seg["speaker"]
            elif overlap <= 0:
                # Track nearest segment for untagged words
                dist = min(abs(w_mid - seg["start"]), abs(w_mid - seg["end"]))
                if dist < best_distance:
                    best_distance = dist
                    if best_overlap <= 0:
                        best_speaker = seg["speaker"]
        if best_speaker is not None:
            word["speaker"] = best_speaker
            tagged += 1

    log.debug(f"Tagged {tagged}/{len(words)} words with speakers")


def get_admin_state():
    """Build admin state snapshot for pushing to admin clients."""
    translation_counts = {}
    for ws, cs in client_state.items():
        if ws in active_clients:
            tl = cs.get("target_language", "en")
            translation_counts[tl] = translation_counts.get(tl, 0) + 1
    stats = pipeline.get("stats", {})
    return {
        "type": "state",
        "running": pipeline["running"],
        "status": pipeline["status"],
        "mode": pipeline.get("mode", "synced"),
        "audio_source": pipeline.get("audio_source", "system"),
        "mic_device": pipeline.get("mic_device"),
        "broadcast_audio": pipeline.get("broadcast_audio", True),
        "translate_enabled": pipeline.get("translate_enabled", True),
        "diarize_enabled": pipeline.get("diarize_enabled", True),
        "chunk_seconds": pipeline["chunk_seconds"],
        "overlap_seconds": pipeline["overlap_seconds"],
        "clients": len(active_clients),
        "buffer_seconds": round(pipeline["audio_delay"], 1),
        "detected_language": stats.get("detected_language"),
        "translations": translation_counts,
        "processing": {
            "transcription": round(stats.get("transcription_time", 0), 1),
            "diarization": round(stats.get("diarization_time", 0), 1),
            "translations": {k: round(v, 2) for k, v in stats.get("translation_times", {}).items()},
        },
    }


def _viewer_status_msg():
    """Build the status message dict for viewer clients."""
    status = pipeline["status"]  # stopped | buffering | capturing
    msg = {"type": "status", "status": status}
    if status != "stopped":
        msg["buffer_seconds"] = pipeline["audio_delay"]
        msg["chunk_seconds"] = pipeline["chunk_seconds"]
        msg["broadcast_audio"] = pipeline.get("broadcast_audio", True)
        if pipeline.get("original_output_device"):
            msg["outputDevice"] = pipeline["original_output_device"]
    return msg


async def _notify_viewers_settings_changed():
    """Push updated settings + sync reset to all viewer clients."""
    translate_on = pipeline.get("translate_enabled", True) and pipeline.get("translator") is not None
    settings_msg = json.dumps({
        "type": "settings",
        "translate_enabled": translate_on,
        "chunk_seconds": pipeline["chunk_seconds"],
        "overlap_seconds": pipeline["overlap_seconds"],
    })
    reset_msg = json.dumps({"type": "sync_reset"})
    for client in list(connected_clients):
        try:
            await client.send(settings_msg)
            await client.send(reset_msg)
        except Exception:
            pass


async def broadcast_status_to_viewers():
    """Send current pipeline status to all connected viewer clients."""
    status_msg = _viewer_status_msg()
    log.debug(f"Broadcasting status '{status_msg['status']}' to {len(connected_clients)} viewers")
    msg = json.dumps(status_msg)
    if connected_clients:
        await asyncio.gather(
            *[client.send(msg) for client in list(connected_clients)],
            return_exceptions=True,
        )


def transcription_thread_fn(transcription_buffer, transcriber, config):
    """Pull overlapping chunks from ring buffer and transcribe."""
    log.info(f"Transcription thread started: chunk={pipeline['chunk_seconds']}s, "
             f"overlap={pipeline['overlap_seconds']}s, delay={pipeline['audio_delay']:.1f}s")
    next_position = transcription_buffer.write_position
    diarizer = pipeline.get("diarizer")
    translator = pipeline.get("translator")

    # Import langdetect lazily (only needed if translator is active)
    detect_lang = None
    if translator:
        try:
            from langdetect import detect
            detect_lang = detect
        except ImportError:
            log.warning("langdetect not installed — language detection disabled")

    try:
        while pipeline["running"]:
            # Check if a language change needs re-translation of last subtitle
            if pipeline.get("retranslate") and translator and pipeline.get("last_subtitle"):
                pipeline["retranslate"] = False
                last = pipeline["last_subtitle"]
                detected_lang = last.get("detected_language")
                target_langs = set()
                for ws, cs in client_state.items():
                    if ws in active_clients:
                        target_langs.add(cs.get("target_language", "en"))
                translations = {}
                if detected_lang:
                    for tl in target_langs:
                        if tl == detected_lang:
                            continue
                        try:
                            t2 = time.monotonic()
                            tr = translator.translate(last["text"], detected_lang, tl)
                            log.info(f"Re-translation: {time.monotonic()-t2:.2f}s ({detected_lang}->{tl})")
                            translations[tl] = tr
                        except Exception as e:
                            log.warning(f"Re-translation error: {e}")
                _enqueue_subtitle({**last, "translations": translations})

            chunk_secs = pipeline["chunk_seconds"]
            overlap_secs = pipeline["overlap_seconds"]
            chunk_samples = chunk_secs * 16000
            overlap_samples = overlap_secs * 16000
            step_samples = chunk_samples - overlap_samples

            if transcription_buffer.write_position < next_position + chunk_samples:
                time.sleep(0.1)
                continue

            chunk = transcription_buffer.read_at(next_position, chunk_samples)
            if chunk is None:
                next_position = max(0, transcription_buffer.write_position - chunk_samples)
                continue

            chunk_offset = next_position / 16000.0

            # Skip near-silent chunks — saves ~4s of wasted model processing
            rms = (chunk.astype(np.float32) ** 2).mean() ** 0.5
            peak = np.max(np.abs(chunk))
            if rms < 50:
                log.debug(f"Skipping silent chunk [{chunk_offset:.1f}s]: RMS={rms:.1f}, peak={peak}")
                next_position += step_samples
                continue
            log.debug(f"Audio chunk [{chunk_offset:.1f}s]: RMS={rms:.1f}, peak={peak}, samples={len(chunk)}")

            try:
                t0 = time.monotonic()

                # Transcribe full chunk
                segments = transcriber.transcribe(
                    chunk,
                    chunk_offset_seconds=chunk_offset,
                    overlap_seconds=overlap_secs,
                )
                transcription_time = time.monotonic() - t0

                # Diarize (same thread — MLX models are thread-local)
                speaker_segments = None
                diar_time = 0
                if pipeline.get("diarize_enabled", True) and diarizer:
                    try:
                        t1 = time.monotonic()
                        speaker_segments = diarizer.diarize_chunk(
                            chunk,
                            overlap_samples=overlap_samples,
                            chunk_offset=chunk_offset,
                        )
                        diar_time = time.monotonic() - t1
                        log.info(f"Diarization: {diar_time:.1f}s | {len(speaker_segments)} speaker segments")
                    except Exception as e:
                        log.warning(f"Diarization error: {e}")

                log.debug(f"Transcription returned {len(segments) if segments else 0} segments")
                if segments:
                    all_words = []
                    all_text = []
                    for seg in segments:
                        all_text.append(seg.text)
                        all_words.extend(seg.words or [])

                    # Tag words with speaker IDs from diarization
                    if speaker_segments:
                        _tag_words_with_speakers(all_words, speaker_segments)

                    combined_text = " ".join(all_text)

                    # Detect language
                    detected_lang = None
                    if detect_lang and combined_text.strip():
                        try:
                            detected_lang = detect_lang(combined_text)
                        except Exception:
                            detected_lang = None

                    # Collect unique target languages from active clients
                    target_langs = set()
                    for ws, cs in client_state.items():
                        if ws in active_clients:
                            target_langs.add(cs.get("target_language", "en"))

                    # Translate to each unique target language
                    translations = {}
                    translation_times = {}
                    if pipeline.get("translate_enabled", True) and translator and detected_lang:
                        for tl in target_langs:
                            if tl == detected_lang:
                                continue
                            try:
                                t2 = time.monotonic()
                                tr = translator.translate(combined_text, detected_lang, tl)
                                elapsed = time.monotonic() - t2
                                translations[tl] = tr
                                translation_times[tl] = elapsed
                                log.info(f"Translation: {elapsed:.2f}s ({detected_lang}->{tl})")
                            except Exception as e:
                                log.warning(f"Translation error ({detected_lang}->{tl}): {e}")

                    subtitle = {
                        "type": "subtitle",
                        "text": combined_text,
                        "translations": translations,
                        "detected_language": detected_lang,
                        "start": segments[0].start,
                        "end": segments[-1].end,
                        "words": all_words,
                    }
                    pipeline["last_subtitle"] = subtitle
                    _enqueue_subtitle(subtitle)
                    log.debug(f"Enqueued subtitle: {combined_text[:60]}...")

                    # Track total processing time (including translation)
                    translate_time = sum(translation_times.values()) if translation_times else 0
                    processing_time = transcription_time + diar_time + translate_time

                    if "transcription_times" not in pipeline:
                        pipeline["transcription_times"] = []
                    pipeline["transcription_times"].append(processing_time)
                    pipeline["transcription_times"] = pipeline["transcription_times"][-10:]
                    avg_processing = sum(pipeline["transcription_times"]) / len(pipeline["transcription_times"])

                    margin = 1 if chunk_secs <= 3 else 2
                    required_delay = chunk_secs + avg_processing + margin

                    log.info(
                        f"Final: {processing_time:.1f}s (transcribe:{transcription_time:.1f}s + diarize:{diar_time:.1f}s + translate:{translate_time:.1f}s) | "
                        f"Required buffer: {required_delay:.1f}s | Current buffer: {pipeline['audio_delay']:.1f}s"
                    )

                    # Auto-adjust audio delay (runtime only, not persisted)
                    step_secs = chunk_secs - overlap_secs
                    if avg_processing > step_secs and len(pipeline.get("transcription_times", [])) >= 3:
                        log.warning(
                            f"Processing ({avg_processing:.1f}s) exceeds step time ({step_secs:.1f}s) — "
                            f"audio will drift. Consider increasing chunk_seconds or disabling translation."
                        )
                    if pipeline["audio_delay"] < required_delay:
                        pipeline["audio_delay"] = required_delay
                        log.info(f"Auto-adjusted audio buffer UP to {required_delay:.1f}s")
                    elif pipeline["audio_delay"] > required_delay + 3 and len(pipeline.get("transcription_times", [])) >= 5:
                        pipeline["audio_delay"] = required_delay
                        log.info(f"Auto-adjusted audio buffer DOWN to {required_delay:.1f}s")

                    # Update stats
                    pipeline["stats"] = {
                        "transcription_time": transcription_time,
                        "diarization_time": diar_time,
                        "translation_times": translation_times,
                        "detected_language": detected_lang,
                    }
            except Exception as e:
                log.warning(f"Transcription error: {e}", exc_info=True)
                _enqueue_subtitle({
                    "type": "subtitle",
                    "text": "Transcription unavailable",
                    "start": chunk_offset,
                    "end": chunk_offset + chunk_secs,
                    "words": [],
                })

            next_position += step_samples
    except Exception as e:
        log.error(f"Transcription thread error: {e}")
    finally:
        log.info("Transcription thread stopped")


def streaming_transcription_thread_fn(transcription_buffer, config):
    """Streaming transcription for realtime mode — feeds audio continuously."""
    log.info("Streaming transcription thread started")

    model_name = config.get("LOCAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit")
    # Use lower delay for streaming — trades accuracy for speed
    delay_ms = int(config.get("STREAMING_DELAY_MS", "320"))
    streamer = StreamingTranscriber(model_name=model_name, delay_ms=delay_ms)
    log.info(f"Streaming transcriber ready: delay={delay_ms}ms")

    translator = pipeline.get("translator")
    detect_lang = None
    if translator:
        try:
            from langdetect import detect
            detect_lang = detect
        except ImportError:
            log.warning("langdetect not installed — language detection disabled")

    # Read position in the transcription buffer (16kHz)
    read_pos = transcription_buffer.write_position
    # Feed audio in small chunks: 80ms at 16kHz = 1280 samples
    feed_size = 1280
    total_fed = 0
    first_result_logged = False
    last_partial_time = 0.0
    last_partial_text = ""
    PARTIAL_INTERVAL = 0.15  # rate-limit partials to avoid flashing

    try:
        while pipeline["running"]:
            # Feed any available audio
            available = transcription_buffer.write_position - read_pos
            fed_this_round = 0
            if available >= feed_size:
                while available >= feed_size and pipeline["running"]:
                    chunk = transcription_buffer.read_at(read_pos, feed_size)
                    if chunk is not None:
                        # Always feed in streaming mode — model handles silence
                        # with PAD tokens, which we use for sentence boundary detection
                        streamer.feed(chunk)
                        fed_this_round += feed_size
                        read_pos += feed_size
                        available = transcription_buffer.write_position - read_pos
                    else:
                        break
                total_fed += fed_this_round
                if fed_this_round > 0 and total_fed <= feed_size * 20:
                    log.debug(f"Streaming: fed {fed_this_round} samples (total: {total_fed}, {total_fed/16000:.1f}s)")

            # Poll for results
            results = streamer.poll()
            if results and not first_result_logged:
                log.info(f"Streaming: first result after {total_fed/16000:.1f}s of audio — {results[0]}")
                first_result_logged = True
            for r in results:
                if r["type"] == "partial":
                    now = time.monotonic()
                    # Rate-limit partials and skip if text unchanged
                    if r["text"] != last_partial_text and now - last_partial_time >= PARTIAL_INTERVAL:
                        _enqueue_subtitle({
                            "type": "partial",
                            "text": r["text"],
                        })
                        last_partial_time = now
                        last_partial_text = r["text"]
                elif r["type"] == "final":
                    last_partial_text = ""  # reset for next sentence
                    text = r["text"]
                    # Detect language and translate
                    detected_lang = None
                    if detect_lang and text.strip():
                        try:
                            detected_lang = detect_lang(text)
                        except Exception:
                            detected_lang = None

                    translations = {}
                    if pipeline.get("translate_enabled", True) and translator and detected_lang:
                        target_langs = set()
                        for ws, cs in client_state.items():
                            if ws in active_clients:
                                target_langs.add(cs.get("target_language", "en"))
                        for tl in target_langs:
                            if tl == detected_lang:
                                continue
                            try:
                                t0 = time.monotonic()
                                tr = translator.translate(text, detected_lang, tl)
                                log.info(f"Streaming translation: {time.monotonic()-t0:.2f}s ({detected_lang}->{tl})")
                                translations[tl] = tr
                            except Exception as e:
                                log.warning(f"Streaming translation error: {e}")

                    log.info(f"Streaming final: '{text[:50]}' lang={detected_lang} "
                             f"translations={list(translations.keys()) if translations else 'none'}")
                    _enqueue_subtitle({
                        "type": "subtitle",
                        "text": text,
                        "translations": translations,
                        "detected_language": detected_lang,
                        "start": r.get("start", 0),
                        "end": r.get("end", 0),
                        "words": [],
                    })

            # Small sleep to avoid busy-waiting but keep latency low
            time.sleep(0.02)

    except Exception as e:
        log.error(f"Streaming transcription thread error: {e}", exc_info=True)
    finally:
        streamer.reset()
        log.info("Streaming transcription thread stopped")


def _create_transcriber(config):
    """Create and return a local transcriber."""
    return LocalTranscriber(
        model_name=config.get("LOCAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit"),
        delay_ms=int(config.get("TRANSCRIPTION_DELAY_MS", "480")),
    )


def _start_pipeline_common(config):
    """Common pipeline setup shared by all start functions. Returns (capture, transcription_buffer)."""
    if pipeline["running"]:
        return None, None

    buffer_seconds = int(config["BUFFER_SECONDS"])
    playback_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=48000)
    transcription_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=16000)
    pipeline["playback_buffer"] = playback_buffer
    pipeline["transcription_buffer"] = transcription_buffer

    capture = AudioCapture(playback_buffer, transcription_buffer)
    pipeline["audio_capture"] = capture
    pipeline["transcriber"] = _create_transcriber(config)
    pipeline["audio_encoder"] = AudioEncoder(sample_rate=48000, channels=1)

    return capture, transcription_buffer


def _finish_pipeline_start(config, transcription_buffer):
    """Start transcription thread and mark pipeline as running."""
    pipeline["_generation"] = pipeline.get("_generation", 0) + 1
    pipeline["running"] = True
    pipeline["status"] = "buffering"
    is_realtime = pipeline.get("mode") == "realtime"
    if is_realtime:
        pipeline["transcription_thread"] = threading.Thread(
            target=streaming_transcription_thread_fn, args=(transcription_buffer, config), daemon=True
        )
    else:
        pipeline["transcription_thread"] = threading.Thread(
            target=transcription_thread_fn, args=(transcription_buffer, pipeline["transcriber"], config), daemon=True
        )
    pipeline["transcription_thread"].start()
    log.info("Pipeline started")


def start_pipeline(config):
    """Start the audio capture and transcription pipeline (system audio)."""
    capture, transcription_buffer = _start_pipeline_common(config)
    if capture is None:
        return None

    original_device = capture.start()
    pipeline["original_output_device"] = original_device

    _finish_pipeline_start(config, transcription_buffer)
    return original_device


def start_pipeline_mic(config, mic_device=None):
    """Start the pipeline capturing from microphone only."""
    capture, transcription_buffer = _start_pipeline_common(config)
    if capture is None:
        return None

    capture.start_mic(mic_device)
    pipeline["original_output_device"] = None

    _finish_pipeline_start(config, transcription_buffer)
    return None


def start_pipeline_both(config, mic_device=None):
    """Start the pipeline capturing from both system audio and microphone."""
    capture, transcription_buffer = _start_pipeline_common(config)
    if capture is None:
        return None

    original_device = capture.start_both(mic_device)
    pipeline["original_output_device"] = original_device

    _finish_pipeline_start(config, transcription_buffer)
    return original_device


def stop_pipeline():
    """Stop the audio capture and transcription pipeline."""
    pipeline["running"] = False
    pipeline["status"] = "stopped"

    if pipeline["audio_capture"]:
        pipeline["audio_capture"].stop()
        pipeline["audio_capture"] = None

    if pipeline["transcription_thread"]:
        # Thread checks pipeline["running"] and will exit on its own
        pipeline["transcription_thread"].join(timeout=1)
        pipeline["transcription_thread"] = None

    # Reset speaker tracking but keep model loaded (expensive to reload)
    if pipeline.get("diarizer"):
        pipeline["diarizer"].reset()

    # Clear any pending subtitles
    if pipeline.get("subtitle_queue"):
        while not pipeline["subtitle_queue"].empty():
            try:
                pipeline["subtitle_queue"].get_nowait()
            except Exception:
                break

    pipeline["playback_buffer"] = None
    pipeline["transcription_buffer"] = None
    pipeline["transcriber"] = None
    pipeline["audio_encoder"] = None
    pipeline["original_output_device"] = None
    pipeline.pop("_audio_logged", None)
    pipeline.pop("transcription_times", None)

    log.info("Pipeline stopped")


async def broadcast_audio():
    """Read from ring buffer with delay, encode to WAV, broadcast to clients."""
    pipeline_generation = 0  # track pipeline restarts

    while True:
        # Wait for pipeline to start
        while not pipeline["running"]:
            await asyncio.sleep(0.1)

        playback_buffer = pipeline["playback_buffer"]
        encoder = pipeline["audio_encoder"]
        current_gen = pipeline.get("_generation", 0)

        if not playback_buffer or not encoder:
            await asyncio.sleep(0.1)
            continue

        # Wait for enough audio to start playback at the configured delay
        delay_samples = int(pipeline["audio_delay"] * 48000)
        log.info(f"Waiting for audio buffer to fill: need {delay_samples} samples ({pipeline['audio_delay']:.1f}s)")
        while pipeline["running"] and pipeline.get("_generation", 0) == current_gen:
            if playback_buffer.write_position >= delay_samples:
                break
            await asyncio.sleep(0.1)

        # If generation changed, loop back to pick up new buffer
        if pipeline.get("_generation", 0) != current_gen:
            continue

        # Buffer filled — transition to capturing
        pipeline["status"] = "capturing"
        log.info(f"Audio buffer filled ({pipeline['audio_delay']:.1f}s) — now broadcasting")
        try:
            await broadcast_status_to_viewers()
            await push_state_to_admins()
        except Exception as e:
            log.warning(f"Status broadcast error on buffer fill: {e}")

        # 50ms chunks at 48kHz = 2400 samples (low latency for realtime)
        chunk_size = 2400 if pipeline.get("mode") == "realtime" else 9600
        read_position = 0

        while pipeline["running"] and pipeline.get("_generation", 0) == current_gen:
            if not pipeline.get("broadcast_audio", True):
                await asyncio.sleep(0.1)
                continue

            delay_offset = int(pipeline["audio_delay"] * 48000)
            target_position = playback_buffer.write_position - delay_offset
            if target_position < chunk_size:
                await asyncio.sleep(0.05)
                continue

            # Re-sync if we've fallen behind (never jump backward to avoid replaying)
            if read_position == 0:
                read_position = target_position
            elif read_position < target_position - 48000:
                read_position = target_position

            # Don't read ahead of target — prevents audio drift vs subtitles
            if read_position >= target_position:
                await asyncio.sleep(0.01)
                continue

            # Don't read past what's available
            if read_position + chunk_size > playback_buffer.write_position:
                await asyncio.sleep(0.01)
                continue

            chunk = playback_buffer.read_at(read_position, chunk_size)
            if chunk is None:
                await asyncio.sleep(0.01)
                continue

            # Stream time of this audio chunk (seconds from capture start)
            stream_time = read_position / 48000.0
            read_position += chunk_size

            try:
                # Send raw PCM bytes (int16, mono, 48kHz) — client decodes synchronously
                raw_pcm = chunk.tobytes()
                if not pipeline.get("_audio_logged"):
                    log.info(f"First audio chunk sent to {len(active_clients)} clients (stream_time={stream_time:.1f}s)")
                    pipeline["_audio_logged"] = True
                if active_clients:
                    # Send stream position periodically so client can sync subtitles
                    # (every ~200ms regardless of chunk size to avoid flooding)
                    chunks_since_sync = getattr(broadcast_audio, '_chunks_since_sync', 0)
                    if chunks_since_sync == 0 or chunks_since_sync * chunk_size >= 9600:
                        sync_msg = json.dumps({"type": "audio_sync", "stream_time": stream_time})
                        await asyncio.gather(
                            *[client.send(sync_msg) for client in active_clients],
                            return_exceptions=True,
                        )
                        broadcast_audio._chunks_since_sync = 0
                    broadcast_audio._chunks_since_sync = getattr(broadcast_audio, '_chunks_since_sync', 0) + 1
                    await asyncio.gather(
                        *[client.send(raw_pcm) for client in active_clients],
                        return_exceptions=True,
                    )
            except Exception as e:
                log.warning(f"Broadcast error: {e}")

            # Sleep slightly less than chunk duration to stay ahead
            await asyncio.sleep(0.04 if chunk_size <= 2400 else 0.19)


async def broadcast_subtitles():
    """Forward subtitles from the queue to all WebSocket clients, with per-client translations."""
    while True:
        try:
            subtitle = await asyncio.wait_for(
                pipeline["subtitle_queue"].get(), timeout=0.5
            )
            if not active_clients:
                continue

            # Partial subtitles — broadcast raw text immediately, no per-client translation
            if subtitle.get("type") == "partial":
                msg = json.dumps(subtitle)
                await asyncio.gather(
                    *[client.send(msg) for client in list(active_clients)],
                    return_exceptions=True,
                )
                continue

            log.debug(f"Broadcasting subtitle to {len(active_clients)} active clients")
            for client in list(active_clients):
                try:
                    cs = client_state.get(client, {})
                    tl = cs.get("target_language", "en")
                    client_translations = subtitle.get("translations", {})
                    msg = json.dumps({
                        **subtitle,
                        "translation": client_translations.get(tl),
                        "target_language": tl,
                        "translations": None,
                    })
                    await client.send(msg)
                except Exception:
                    pass
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            log.warning(f"Subtitle broadcast error: {e}")


async def push_state_to_admins():
    """Push current admin state once to all admin clients."""
    if admin_clients:
        msg = json.dumps(get_admin_state())
        await asyncio.gather(
            *[client.send(msg) for client in list(admin_clients)],
            return_exceptions=True,
        )


async def push_admin_stats():
    """Push admin state to all admin clients every second."""
    while True:
        try:
            if admin_clients:
                state = get_admin_state()
                msg = json.dumps(state)
                await asyncio.gather(
                    *[client.send(msg) for client in list(admin_clients)],
                    return_exceptions=True,
                )
        except Exception as e:
            log.warning(f"Admin stats push error: {e}")
        await asyncio.sleep(1)


async def handle_websocket(websocket):
    """Handle a viewer WebSocket connection (passive — no start/stop control)."""
    connected_clients.add(websocket)
    client_state[websocket] = {"target_language": pipeline.get("default_target_language", "en")}
    log.info(f"Client connected ({len(connected_clients)} total)")

    # Send settings
    await websocket.send(json.dumps({
        "type": "settings",
        "audio_delay": pipeline["audio_delay"],
        "chunk_seconds": pipeline["chunk_seconds"],
        "overlap_seconds": pipeline["overlap_seconds"],
        "target_language": client_state[websocket]["target_language"],
        "translate_enabled": pipeline.get("translate_enabled", True) and pipeline.get("translator") is not None,
    }))

    # Send current pipeline state so reconnecting clients show the right UI
    status_msg = _viewer_status_msg()
    log.debug(f"Sending status to new client: {status_msg['status']} (running={pipeline['running']}, active={len(active_clients)})")
    await websocket.send(json.dumps(status_msg))
    if pipeline["running"]:
        active_clients.add(websocket)
        log.debug(f"Added client to active_clients ({len(active_clients)} active)")

    try:
        async for message in websocket:
            data = json.loads(message)
            if data.get("type") == "config":
                if "target_language" in data:
                    cs = client_state.get(websocket, {})
                    cs["target_language"] = data["target_language"]
                    client_state[websocket] = cs
                    pipeline["retranslate"] = True
                    log.info(f"Client target language set to {data['target_language']}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        active_clients.discard(websocket)
        client_state.pop(websocket, None)
        log.info(f"Client disconnected ({len(connected_clients)} total)")


async def handle_admin_websocket(websocket):
    """Handle an admin WebSocket connection with pipeline controls."""
    admin_clients.add(websocket)
    log.info(f"Admin connected ({len(admin_clients)} total)")

    # Send current state
    await websocket.send(json.dumps(get_admin_state()))

    # Send microphone list
    try:
        mics = AudioCapture.list_microphones()
    except Exception:
        mics = []
    await websocket.send(json.dumps({
        "type": "microphones",
        "devices": mics,
    }))

    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "start":
                config = load_config()
                audio_source = pipeline.get("audio_source", "system")
                mic_device = pipeline.get("mic_device")
                if audio_source == "mic":
                    start_pipeline_mic(config, mic_device=mic_device)
                elif audio_source == "both":
                    start_pipeline_both(config, mic_device=mic_device)
                else:
                    start_pipeline(config)
                active_clients.update(connected_clients)
                await broadcast_status_to_viewers()

            elif msg_type == "stop":
                stop_pipeline()
                active_clients.clear()
                await broadcast_status_to_viewers()

            elif msg_type == "mode":
                mode = data.get("mode", "synced")
                if mode in MODE_PRESETS:
                    was_running = pipeline["running"]
                    old_mode = pipeline.get("mode")
                    pipeline["mode"] = mode
                    preset = MODE_PRESETS[mode]
                    for k, v in preset.items():
                        pipeline[k] = v
                    save_settings()
                    log.info(f"Mode set to {mode}: chunk={pipeline['chunk_seconds']}s, "
                             f"translate={pipeline['translate_enabled']}, diarize={pipeline['diarize_enabled']}, "
                             f"audio_delay={pipeline['audio_delay']:.1f}s")
                    # Restart pipeline if running so new settings take effect cleanly
                    if was_running:
                        config = load_config()
                        audio_source = pipeline.get("audio_source", "system")
                        mic_device = pipeline.get("mic_device")
                        stop_pipeline()
                        # Restore mode settings (stop_pipeline resets chunk/overlap to defaults)
                        for k, v in preset.items():
                            pipeline[k] = v
                        pipeline["mode"] = mode
                        active_clients.clear()
                        if audio_source == "mic":
                            start_pipeline_mic(config, mic_device=mic_device)
                        elif audio_source == "both":
                            start_pipeline_both(config, mic_device=mic_device)
                        else:
                            start_pipeline(config)
                        active_clients.update(connected_clients)
                        await broadcast_status_to_viewers()
                    await _notify_viewers_settings_changed()

            elif msg_type == "audio_source":
                new_source = data.get("source", "system")
                new_mic = data.get("device")
                old_source = pipeline.get("audio_source")
                pipeline["audio_source"] = new_source
                pipeline["mic_device"] = new_mic
                save_settings()
                log.info(f"Audio source set to {new_source} (mic: {new_mic})")
                # If pipeline is running, restart with new source
                if pipeline["running"]:
                    config = load_config()
                    # Preserve current mode settings across restart
                    mode = pipeline.get("mode", "synced")
                    mode_settings = {k: pipeline[k] for k in MODE_PRESETS.get(mode, {}) if k in pipeline}
                    log.info(f"Restarting pipeline for audio source change: {old_source} -> {new_source}")
                    stop_pipeline()
                    for k, v in mode_settings.items():
                        pipeline[k] = v
                    pipeline["audio_source"] = new_source
                    pipeline["mic_device"] = new_mic
                    active_clients.clear()
                    if new_source == "mic":
                        start_pipeline_mic(config, mic_device=new_mic)
                    elif new_source == "both":
                        start_pipeline_both(config, mic_device=new_mic)
                    else:
                        start_pipeline(config)
                    active_clients.update(connected_clients)
                    await broadcast_status_to_viewers()

            elif msg_type == "toggle":
                feature = data.get("feature")
                enabled = data.get("enabled")
                if feature in ("broadcast_audio", "translate_enabled", "diarize_enabled"):
                    pipeline[feature] = bool(enabled) if enabled is not None else not pipeline.get(feature, True)
                    save_settings()
                    log.info(f"{feature} set to {pipeline[feature]}")
                    if feature == "translate_enabled":
                        await _notify_viewers_settings_changed()

            elif msg_type == "tuning":
                needs_sync_reset = False
                if "chunk_seconds" in data:
                    old_chunk = pipeline["chunk_seconds"]
                    pipeline["chunk_seconds"] = int(data["chunk_seconds"])
                    chunk_delta = pipeline["chunk_seconds"] - old_chunk
                    if chunk_delta != 0:
                        pipeline["audio_delay"] = max(0, pipeline["audio_delay"] + chunk_delta)
                        log.info(f"Chunk size: {old_chunk}s -> {pipeline['chunk_seconds']}s | Audio buffer adjusted to {pipeline['audio_delay']:.1f}s")
                        needs_sync_reset = True
                if "overlap_seconds" in data:
                    pipeline["overlap_seconds"] = int(data["overlap_seconds"])
                    log.info(f"Overlap set to {pipeline['overlap_seconds']}s")
                    needs_sync_reset = True
                if needs_sync_reset:
                    pipeline.pop("transcription_times", None)
                    while not pipeline["subtitle_queue"].empty():
                        try:
                            pipeline["subtitle_queue"].get_nowait()
                        except Exception:
                            break
                    if active_clients:
                        reset_msg = json.dumps({"type": "sync_reset"})
                        await asyncio.gather(
                            *[client.send(reset_msg) for client in list(active_clients)],
                            return_exceptions=True,
                        )
                save_settings()

            # After any command, push updated state back to all admins
            state_msg = json.dumps(get_admin_state())
            await asyncio.gather(
                *[client.send(state_msg) for client in list(admin_clients)],
                return_exceptions=True,
            )

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        admin_clients.discard(websocket)
        log.info(f"Admin disconnected ({len(admin_clients)} total)")


async def main():
    config = load_config()
    host = config["HOST"]
    port = int(config["PORT"])
    admin_host = config.get("ADMIN_HOST", "127.0.0.1")
    admin_port = int(config.get("ADMIN_PORT", "8001"))
    pipeline["loop"] = asyncio.get_running_loop()

    # Init pipeline flags from config
    pipeline["translate_enabled"] = config.get("TRANSLATE", "true").lower() in ("1", "true", "yes")
    pipeline["diarize_enabled"] = config.get("DIARIZE", "true").lower() in ("1", "true", "yes")
    pipeline["default_target_language"] = config.get("TARGET_LANGUAGE", "en")

    # Preload models on startup so first transcription is fast
    preload_model(config.get("LOCAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit"))
    pipeline["diarizer"] = create_diarizer(config)
    pipeline["translator"] = create_translator(config)

    async with serve(
        handle_websocket,
        host,
        port,
        process_request=handle_http,
    ) as viewer_server:
        async with serve(
            handle_admin_websocket,
            admin_host,
            admin_port,
            process_request=handle_http_admin,
        ) as admin_server:
            log.info(f"Viewer server running at http://{host}:{port}")
            log.info(f"Admin server running at http://{admin_host}:{admin_port}")
            await asyncio.gather(
                asyncio.Future(),
                broadcast_audio(),
                broadcast_subtitles(),
                push_admin_stats(),
            )


import signal


def handle_shutdown(sig, frame):
    log.info("Shutting down...")
    stop_pipeline()
    raise SystemExit(0)


signal.signal(signal.SIGINT, handle_shutdown)
signal.signal(signal.SIGTERM, handle_shutdown)

if __name__ == "__main__":
    asyncio.run(main())
