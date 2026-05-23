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
from encoder import AudioEncoder
from audio_capture import AudioCapture

log_level = os.environ.get("LOGLEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, log_level, logging.INFO), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)

logging.getLogger("websockets").setLevel(logging.CRITICAL)
logging.getLogger("httpx").setLevel(logging.WARNING)


def load_config():
    """Load configuration from .env file."""
    config = {
        "WHISPER_ENDPOINT": "",
        "WHISPER_MODEL": "",
        "WHISPER_API_KEY": "",
        "PORT": "8000",
        "HOST": "0.0.0.0",
        "BUFFER_SECONDS": "10",
        "CHUNK_SECONDS": "5",
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


connected_clients = set()
active_clients = set()  # clients that have hit Start

# --- Pipeline state ---
pipeline = {
    "running": False,
    "playback_buffer": None,  # 48kHz for audio streaming
    "whisper_buffer": None,   # 16kHz for transcription
    "audio_capture": None,
    "whisper_client": None,
    "audio_encoder": None,
    "subtitle_queue": asyncio.Queue(),
    "whisper_thread": None,
    "loop": None,
    "original_output_device": None,
    "audio_delay": 6.0,
}


def _enqueue_subtitle(item):
    """Thread-safe enqueue: schedule put_nowait on the event loop."""
    loop = pipeline.get("loop")
    if loop:
        loop.call_soon_threadsafe(pipeline["subtitle_queue"].put_nowait, item)


def whisper_thread_fn(whisper_buffer, whisper_client, config):
    """Pull overlapping chunks from ring buffer and transcribe."""
    log.info("Whisper thread started")
    chunk_samples = int(config["CHUNK_SECONDS"]) * 16000
    overlap_samples = int(config["OVERLAP_SECONDS"]) * 16000
    step_samples = chunk_samples - overlap_samples
    next_position = whisper_buffer.write_position

    try:
        while pipeline["running"]:
            if whisper_buffer.write_position < next_position + chunk_samples:
                time.sleep(0.1)
                continue

            chunk = whisper_buffer.read_at(next_position, chunk_samples)
            if chunk is None:
                next_position = max(0, whisper_buffer.write_position - chunk_samples)
                continue

            chunk_offset = next_position / 16000.0

            try:
                segments = whisper_client.transcribe(
                    chunk,
                    chunk_offset_seconds=chunk_offset,
                    overlap_seconds=int(config["OVERLAP_SECONDS"]),
                )
                for seg in segments:
                    _enqueue_subtitle({
                        "type": "subtitle",
                        "text": seg.text,
                        "start": seg.start,
                        "end": seg.end,
                        "words": seg.words,
                    })
            except Exception as e:
                log.warning(f"Whisper error: {e}")
                _enqueue_subtitle({
                    "type": "subtitle",
                    "text": "Transcription unavailable",
                    "start": chunk_offset,
                    "end": chunk_offset + float(config["CHUNK_SECONDS"]),
                    "words": [],
                })

            next_position += step_samples
    except Exception as e:
        log.error(f"Whisper thread error: {e}")
    finally:
        log.info("Whisper thread stopped")


def start_pipeline(config):
    """Start the audio capture and transcription pipeline."""
    if pipeline["running"]:
        return None

    buffer_seconds = int(config["BUFFER_SECONDS"])
    playback_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=48000)
    whisper_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=16000)
    pipeline["playback_buffer"] = playback_buffer
    pipeline["whisper_buffer"] = whisper_buffer

    capture = AudioCapture(playback_buffer, whisper_buffer)
    original_device = capture.start()
    pipeline["audio_capture"] = capture
    pipeline["original_output_device"] = original_device

    pipeline["whisper_client"] = WhisperClient(
        endpoint=config["WHISPER_ENDPOINT"],
        model=config["WHISPER_MODEL"],
        api_key=config.get("WHISPER_API_KEY") or None,
    )

    pipeline["audio_encoder"] = AudioEncoder(sample_rate=48000, channels=1)

    pipeline["running"] = True

    pipeline["whisper_thread"] = threading.Thread(
        target=whisper_thread_fn, args=(whisper_buffer, pipeline["whisper_client"], config), daemon=True
    )
    pipeline["whisper_thread"].start()

    log.info("Pipeline started")
    return original_device


def stop_pipeline():
    """Stop the audio capture and transcription pipeline."""
    pipeline["running"] = False

    if pipeline["audio_capture"]:
        pipeline["audio_capture"].stop()
        pipeline["audio_capture"] = None

    if pipeline["whisper_thread"]:
        pipeline["whisper_thread"].join(timeout=5)
        pipeline["whisper_thread"] = None

    pipeline["playback_buffer"] = None
    pipeline["whisper_buffer"] = None
    pipeline["whisper_client"] = None
    pipeline["audio_encoder"] = None
    pipeline["original_output_device"] = None

    log.info("Pipeline stopped")


async def broadcast_audio():
    """Read from ring buffer with delay, encode to WAV, broadcast to clients."""
    while not pipeline["running"]:
        await asyncio.sleep(0.1)

    playback_buffer = pipeline["playback_buffer"]
    encoder = pipeline["audio_encoder"]

    # Wait for initial buffer to fill
    delay_samples = int(pipeline["audio_delay"] * 48000)
    while pipeline["running"]:
        if playback_buffer.write_position >= delay_samples:
            break
        await asyncio.sleep(0.1)

    # 200ms chunks at 48kHz = 9600 samples
    chunk_size = 9600
    read_position = 0

    while pipeline["running"]:
        # Target position: audio_delay seconds behind live
        target_position = playback_buffer.write_position - int(pipeline["audio_delay"] * 48000)
        if target_position < 0:
            await asyncio.sleep(0.05)
            continue

        # Advance read position toward target, but don't skip ahead
        if read_position == 0:
            read_position = target_position

        chunk = playback_buffer.read_at(read_position, chunk_size)
        if chunk is None:
            await asyncio.sleep(0.01)
            continue

        read_position += chunk_size

        try:
            wav_chunk = encoder.encode_wav_chunk(chunk)
            if active_clients:
                await asyncio.gather(
                    *[client.send(wav_chunk) for client in active_clients],
                    return_exceptions=True,
                )
        except Exception as e:
            log.warning(f"Broadcast error: {e}")

        # 200ms of audio at 48kHz
        await asyncio.sleep(0.19)


async def broadcast_subtitles():
    """Forward subtitles from the queue to all WebSocket clients."""
    while True:
        try:
            subtitle = await asyncio.wait_for(
                pipeline["subtitle_queue"].get(), timeout=0.5
            )
            if active_clients:
                msg = json.dumps(subtitle)
                await asyncio.gather(
                    *[client.send(msg) for client in active_clients],
                    return_exceptions=True,
                )
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            log.warning(f"Subtitle broadcast error: {e}")


async def handle_websocket(websocket):
    """Handle a WebSocket connection."""
    connected_clients.add(websocket)
    log.info(f"Client connected ({len(connected_clients)} total)")
    try:
        async for message in websocket:
            data = json.loads(message)
            if data.get("type") == "start":
                active_clients.add(websocket)
                config = load_config()
                original_device = start_pipeline(config)
                await websocket.send(json.dumps({
                    "type": "status",
                    "status": "capturing",
                    "outputDevice": original_device,
                }))
            elif data.get("type") == "stop":
                active_clients.discard(websocket)
                stop_pipeline()
                await websocket.send(json.dumps({"type": "status", "status": "stopped"}))
            elif data.get("type") == "sync":
                pipeline["audio_delay"] = float(data.get("delay", 6.0))
                log.info(f"Audio delay set to {pipeline['audio_delay']}s")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        active_clients.discard(websocket)
        log.info(f"Client disconnected ({len(connected_clients)} total)")
        if not active_clients and pipeline["running"]:
            stop_pipeline()


async def main():
    config = load_config()
    host = config["HOST"]
    port = int(config["PORT"])
    pipeline["loop"] = asyncio.get_running_loop()

    async with serve(
        handle_websocket,
        host,
        port,
        process_request=handle_http,
    ) as server:
        log.info(f"Server running at http://{host}:{port}")
        await asyncio.gather(
            asyncio.Future(),
            broadcast_audio(),
            broadcast_subtitles(),
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
