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
from whisper_client import WhisperClient
from local_transcriber import LocalTranscriber, preload_model
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
        "WHISPER_ENDPOINT": "",
        "WHISPER_MODEL": "",
        "WHISPER_API_KEY": "",
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
    },
    "realtime": {
        "chunk_seconds": 3,
        "overlap_seconds": 1,
        "translate_enabled": False,
        "diarize_enabled": False,
        "broadcast_audio": True,
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

    return websockets.http11.Response(
        200,
        "OK",
        websockets.datastructures.Headers({"Content-Type": content_type}),
        body,
    )


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

    return websockets.http11.Response(
        200,
        "OK",
        websockets.datastructures.Headers({"Content-Type": content_type}),
        body,
    )


connected_clients = set()
active_clients = set()  # clients that are receiving audio/subtitles
admin_clients = set()
client_state = {}  # websocket -> {"target_language": "en"}

# --- Settings persistence ---

SETTINGS_FILE = os.path.join(os.path.dirname(__file__) or ".", ".settings.json")
SETTINGS_DEFAULTS = {"audio_delay": 15.0, "chunk_seconds": 10, "overlap_seconds": 2}


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
    "whisper_buffer": None,   # 16kHz for transcription
    "audio_capture": None,
    "whisper_client": None,
    "audio_encoder": None,
    "subtitle_queue": asyncio.Queue(),
    "diarizer": None,
    "translator": None,
    "whisper_thread": None,
    "loop": None,
    "original_output_device": None,
    "audio_delay": saved["audio_delay"],
    "chunk_seconds": saved["chunk_seconds"],
    "overlap_seconds": saved["overlap_seconds"],
    # Admin / pipeline control state
    "mode": "synced",
    "audio_source": "system",
    "mic_device": None,
    "broadcast_audio": True,
    "translate_enabled": True,
    "diarize_enabled": True,
    "default_target_language": "en",
    "stats": {},
}


def _enqueue_subtitle(item):
    """Thread-safe enqueue: schedule put_nowait on the event loop."""
    loop = pipeline.get("loop")
    if loop:
        loop.call_soon_threadsafe(pipeline["subtitle_queue"].put_nowait, item)


def _tag_words_with_speakers(words, speaker_segments, chunk_offset):
    """Assign a speaker ID to each word based on diarization segments.

    Words have absolute timestamps (offset applied).
    Speaker segments have chunk-relative timestamps (0 to chunk_seconds).
    """
    if not speaker_segments:
        return

    # If one speaker dominates (>80% of total time), skip tagging —
    # the model is probably mis-splitting a single speaker
    speaker_durations = {}
    for seg in speaker_segments:
        spk = seg["speaker"]
        speaker_durations[spk] = speaker_durations.get(spk, 0) + (seg["end"] - seg["start"])
    total_duration = sum(speaker_durations.values())
    if total_duration > 0 and len(speaker_durations) > 1:
        dominant = max(speaker_durations.values())
        if dominant / total_duration > 0.8:
            log.debug(f"Single dominant speaker ({dominant/total_duration:.0%}), skipping diarization tags")
            return

    tagged = 0
    for word in words:
        mid = (word["start"] + word["end"]) / 2
        best_speaker = None
        best_overlap = 0
        for seg in speaker_segments:
            seg_start = seg["start"] + chunk_offset
            seg_end = seg["end"] + chunk_offset
            if seg_start <= mid <= seg_end:
                overlap = min(word["end"], seg_end) - max(word["start"], seg_start)
                if overlap > best_overlap:
                    best_overlap = overlap
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


async def broadcast_status_to_viewers():
    """Send current pipeline status to all connected viewer clients."""
    if pipeline["running"]:
        msg = json.dumps({
            "type": "status",
            "status": "capturing",
            "buffer_seconds": pipeline["audio_delay"],
            "chunk_seconds": pipeline["chunk_seconds"],
        })
    else:
        msg = json.dumps({"type": "status", "status": "stopped"})
    if connected_clients:
        await asyncio.gather(
            *[client.send(msg) for client in list(connected_clients)],
            return_exceptions=True,
        )


def whisper_thread_fn(whisper_buffer, whisper_client, config):
    """Pull overlapping chunks from ring buffer and transcribe."""
    log.info("Whisper thread started")
    pipeline["chunk_seconds"] = int(config["CHUNK_SECONDS"])
    pipeline["overlap_seconds"] = int(config["OVERLAP_SECONDS"])
    next_position = whisper_buffer.write_position
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

            if whisper_buffer.write_position < next_position + chunk_samples:
                time.sleep(0.1)
                continue

            chunk = whisper_buffer.read_at(next_position, chunk_samples)
            if chunk is None:
                next_position = max(0, whisper_buffer.write_position - chunk_samples)
                continue

            chunk_offset = next_position / 16000.0

            try:
                t0 = time.monotonic()

                # Transcribe full chunk
                segments = whisper_client.transcribe(
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
                        speaker_segments = diarizer.diarize_chunk(chunk)
                        diar_time = time.monotonic() - t1
                        log.info(f"Diarization: {diar_time:.1f}s | {len(speaker_segments)} speaker segments")
                    except Exception as e:
                        log.warning(f"Diarization error: {e}")

                processing_time = transcription_time + diar_time

                # Track rolling average processing time
                if "transcription_times" not in pipeline:
                    pipeline["transcription_times"] = []
                pipeline["transcription_times"].append(processing_time)
                pipeline["transcription_times"] = pipeline["transcription_times"][-10:]
                avg_processing = sum(pipeline["transcription_times"]) / len(pipeline["transcription_times"])

                required_delay = chunk_secs + avg_processing + 2  # 2s margin

                log.info(
                    f"Final: {processing_time:.1f}s (transcribe:{transcription_time:.1f}s + diarize:{diar_time:.1f}s) | "
                    f"Required buffer: {required_delay:.1f}s | Current buffer: {pipeline['audio_delay']:.1f}s"
                )

                # Auto-adjust audio delay
                if pipeline["audio_delay"] < required_delay:
                    pipeline["audio_delay"] = required_delay
                    save_settings()
                    log.info(f"Auto-adjusted audio buffer UP to {required_delay:.1f}s")
                elif pipeline["audio_delay"] > required_delay + 3 and len(pipeline.get("transcription_times", [])) >= 5:
                    pipeline["audio_delay"] = required_delay
                    save_settings()
                    log.info(f"Auto-adjusted audio buffer DOWN to {required_delay:.1f}s")

                if segments:
                    all_words = []
                    all_text = []
                    for seg in segments:
                        all_text.append(seg.text)
                        all_words.extend(seg.words or [])

                    # Tag words with speaker IDs from diarization
                    if speaker_segments:
                        _tag_words_with_speakers(all_words, speaker_segments, chunk_offset)

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
                    if pipeline.get("translate_enabled", True) and translator and detected_lang and len(combined_text.split()) >= 3:
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

                    # Update stats
                    pipeline["stats"] = {
                        "transcription_time": transcription_time,
                        "diarization_time": diar_time,
                        "translation_times": translation_times,
                        "detected_language": detected_lang,
                    }
            except Exception as e:
                log.warning(f"Whisper error: {e}", exc_info=True)
                _enqueue_subtitle({
                    "type": "subtitle",
                    "text": "Transcription unavailable",
                    "start": chunk_offset,
                    "end": chunk_offset + chunk_secs,
                    "words": [],
                })

            next_position += step_samples
    except Exception as e:
        log.error(f"Whisper thread error: {e}")
    finally:
        log.info("Whisper thread stopped")


def _create_whisper_client(config):
    """Create and return a whisper client based on config."""
    if config.get("USE_LOCAL_MODEL", "").lower() in ("1", "true", "yes"):
        return LocalTranscriber(
            model_name=config.get("LOCAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit"),
            delay_ms=int(config.get("TRANSCRIPTION_DELAY_MS", "480")),
        )
    else:
        return WhisperClient(
            endpoint=config["WHISPER_ENDPOINT"],
            model=config["WHISPER_MODEL"],
            api_key=config.get("WHISPER_API_KEY") or None,
            timeout=60.0,
            omlx=config.get("WHISPER_OMLX", "").lower() in ("1", "true", "yes"),
        )


def _start_pipeline_common(config):
    """Common pipeline setup shared by all start functions. Returns (capture, whisper_buffer)."""
    if pipeline["running"]:
        return None, None

    buffer_seconds = int(config["BUFFER_SECONDS"])
    playback_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=48000)
    whisper_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=16000)
    pipeline["playback_buffer"] = playback_buffer
    pipeline["whisper_buffer"] = whisper_buffer

    capture = AudioCapture(playback_buffer, whisper_buffer)
    pipeline["audio_capture"] = capture
    pipeline["whisper_client"] = _create_whisper_client(config)
    pipeline["audio_encoder"] = AudioEncoder(sample_rate=48000, channels=1)

    return capture, whisper_buffer


def _finish_pipeline_start(config, whisper_buffer):
    """Start whisper thread and mark pipeline as running."""
    pipeline["running"] = True
    pipeline["whisper_thread"] = threading.Thread(
        target=whisper_thread_fn, args=(whisper_buffer, pipeline["whisper_client"], config), daemon=True
    )
    pipeline["whisper_thread"].start()
    log.info("Pipeline started")


def start_pipeline(config):
    """Start the audio capture and transcription pipeline (system audio)."""
    capture, whisper_buffer = _start_pipeline_common(config)
    if capture is None:
        return None

    original_device = capture.start()
    pipeline["original_output_device"] = original_device

    _finish_pipeline_start(config, whisper_buffer)
    return original_device


def start_pipeline_mic(config, mic_device=None):
    """Start the pipeline capturing from microphone only."""
    capture, whisper_buffer = _start_pipeline_common(config)
    if capture is None:
        return None

    capture.start_mic(mic_device)
    pipeline["original_output_device"] = None

    _finish_pipeline_start(config, whisper_buffer)
    return None


def start_pipeline_both(config, mic_device=None):
    """Start the pipeline capturing from both system audio and microphone."""
    capture, whisper_buffer = _start_pipeline_common(config)
    if capture is None:
        return None

    original_device = capture.start_both(mic_device)
    pipeline["original_output_device"] = original_device

    _finish_pipeline_start(config, whisper_buffer)
    return original_device


def stop_pipeline():
    """Stop the audio capture and transcription pipeline."""
    pipeline["running"] = False

    if pipeline["audio_capture"]:
        pipeline["audio_capture"].stop()
        pipeline["audio_capture"] = None

    if pipeline["whisper_thread"]:
        # Thread checks pipeline["running"] and will exit on its own
        pipeline["whisper_thread"].join(timeout=1)
        pipeline["whisper_thread"] = None

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
    pipeline["whisper_buffer"] = None
    pipeline["whisper_client"] = None
    pipeline["audio_encoder"] = None
    pipeline["original_output_device"] = None
    pipeline["chunk_seconds"] = SETTINGS_DEFAULTS["chunk_seconds"]
    pipeline["overlap_seconds"] = SETTINGS_DEFAULTS["overlap_seconds"]

    log.info("Pipeline stopped")


async def broadcast_audio():
    """Read from ring buffer with delay, encode to WAV, broadcast to clients."""
    while True:
        # Wait for pipeline to start
        while not pipeline["running"]:
            await asyncio.sleep(0.1)

        playback_buffer = pipeline["playback_buffer"]
        encoder = pipeline["audio_encoder"]

        if not playback_buffer or not encoder:
            await asyncio.sleep(0.1)
            continue

        # Wait for enough audio to start playback at the configured delay
        delay_samples = int(pipeline["audio_delay"] * 48000)
        while pipeline["running"]:
            if playback_buffer.write_position >= delay_samples:
                break
            await asyncio.sleep(0.1)

        # 200ms chunks at 48kHz = 9600 samples
        chunk_size = 9600
        read_position = 0

        while pipeline["running"]:
            if not pipeline.get("broadcast_audio", True):
                await asyncio.sleep(0.1)
                continue

            target_position = playback_buffer.write_position - int(pipeline["audio_delay"] * 48000)
            if target_position < 0:
                await asyncio.sleep(0.05)
                continue

            # Re-sync if we've fallen behind (never jump backward to avoid replaying)
            if read_position == 0:
                read_position = target_position
            elif read_position < target_position - 48000:
                read_position = target_position

            chunk = playback_buffer.read_at(read_position, chunk_size)
            if chunk is None:
                await asyncio.sleep(0.01)
                continue

            # Stream time of this audio chunk (seconds from capture start)
            stream_time = read_position / 48000.0
            read_position += chunk_size

            try:
                wav_chunk = encoder.encode_wav_chunk(chunk)
                if active_clients:
                    # Send stream position so client can sync subtitles
                    sync_msg = json.dumps({"type": "audio_sync", "stream_time": stream_time})
                    await asyncio.gather(
                        *[client.send(sync_msg) for client in active_clients],
                        return_exceptions=True,
                    )
                    await asyncio.gather(
                        *[client.send(wav_chunk) for client in active_clients],
                        return_exceptions=True,
                    )
            except Exception as e:
                log.warning(f"Broadcast error: {e}")

            # 200ms of audio at 48kHz
            await asyncio.sleep(0.19)


async def broadcast_subtitles():
    """Forward subtitles from the queue to all WebSocket clients, with per-client translations."""
    while True:
        try:
            subtitle = await asyncio.wait_for(
                pipeline["subtitle_queue"].get(), timeout=0.5
            )
            if active_clients:
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
    if pipeline["running"]:
        await websocket.send(json.dumps({
            "type": "status",
            "status": "capturing",
            "buffer_seconds": pipeline["audio_delay"],
            "chunk_seconds": pipeline["chunk_seconds"],
        }))
        # Auto-add to active clients if pipeline is already running
        active_clients.add(websocket)
    else:
        await websocket.send(json.dumps({"type": "status", "status": "stopped"}))

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
                    pipeline["mode"] = mode
                    preset = MODE_PRESETS[mode]
                    for k, v in preset.items():
                        pipeline[k] = v
                    save_settings()
                    log.info(f"Mode set to {mode}")

            elif msg_type == "audio_source":
                pipeline["audio_source"] = data.get("source", "system")
                pipeline["mic_device"] = data.get("device")
                log.info(f"Audio source set to {pipeline['audio_source']} (mic: {pipeline['mic_device']})")

            elif msg_type == "toggle":
                feature = data.get("feature")
                enabled = data.get("enabled")
                if feature in ("broadcast_audio", "translate_enabled", "diarize_enabled"):
                    pipeline[feature] = bool(enabled) if enabled is not None else not pipeline.get(feature, True)
                    log.info(f"{feature} set to {pipeline[feature]}")

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
    if config.get("USE_LOCAL_MODEL", "").lower() in ("1", "true", "yes"):
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
