import asyncio
import json
import os
import subprocess
import logging
import threading
import time

import numpy as np
import websockets
from websockets.asyncio.server import serve

from buffer import RingBuffer
from whisper_client import WhisperClient
from encoder import AudioEncoder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def load_config():
    """Load configuration from .env file."""
    config = {
        "WHISPER_ENDPOINT": "http://api.local.samfenwick.com/v1/audio/transcriptions",
        "WHISPER_MODEL": "whisper-v3-turbo",
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


def list_audio_sources():
    """Run the Swift capture tool with --list and return parsed JSON."""
    capture_path = os.path.join(os.path.dirname(__file__) or ".", "capture")
    result = subprocess.run(
        [capture_path, "--list"],
        capture_output=True, text=True, timeout=5,
    )
    sources = []
    for line in result.stderr.strip().split("\n"):
        if line:
            try:
                sources.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return sources


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


async def handle_http(connection, request):
    """Serve static files from the static/ directory."""
    static_dir = os.path.join(os.path.dirname(__file__) or ".", "static")
    path = request.path

    if path == "/":
        path = "/index.html"
    elif path == "/api/sources":
        sources = list_audio_sources()
        body = json.dumps(sources).encode()
        return websockets.http11.Response(
            200,
            "OK",
            websockets.datastructures.Headers({"Content-Type": "application/json"}),
            body,
        )

    file_path = os.path.join(static_dir, path.lstrip("/"))
    file_path = os.path.realpath(file_path)

    # Security: ensure we're still inside static_dir
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


# --- WebSocket handler (audio + subtitles added in later tasks) ---

connected_clients = set()

# --- Pipeline state ---
pipeline = {
    "running": False,
    "ring_buffer": None,
    "capture_process": None,
    "whisper_client": None,
    "audio_encoder": None,
    "subtitle_queue": asyncio.Queue(),
    "capture_thread": None,
    "whisper_thread": None,
    "loop": None,
}


def capture_thread_fn(process, ring_buffer):
    """Read PCM from Swift capture subprocess and write to ring buffer."""
    log.info("Capture thread started")
    try:
        while pipeline["running"]:
            data = process.stdout.read(640)
            if not data:
                log.warning("Capture process ended")
                break
            samples = np.frombuffer(data, dtype=np.int16)
            ring_buffer.write(samples)
    except Exception as e:
        log.error(f"Capture thread error: {e}")
    finally:
        log.info("Capture thread stopped")


def _enqueue_subtitle(item):
    """Thread-safe enqueue: schedule put_nowait on the event loop."""
    loop = pipeline.get("loop")
    if loop:
        loop.call_soon_threadsafe(pipeline["subtitle_queue"].put_nowait, item)


def whisper_thread_fn(ring_buffer, whisper_client, config):
    """Pull overlapping chunks from ring buffer and transcribe."""
    log.info("Whisper thread started")
    chunk_samples = int(config["CHUNK_SECONDS"]) * 16000
    overlap_samples = int(config["OVERLAP_SECONDS"]) * 16000
    step_samples = chunk_samples - overlap_samples
    next_position = ring_buffer.write_position

    try:
        while pipeline["running"]:
            if ring_buffer.write_position < next_position + chunk_samples:
                time.sleep(0.1)
                continue

            chunk = ring_buffer.read_at(next_position, chunk_samples)
            if chunk is None:
                next_position = max(0, ring_buffer.write_position - chunk_samples)
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


def start_pipeline(app_name, config):
    """Start the audio capture and transcription pipeline."""
    if pipeline["running"]:
        return

    buffer_seconds = int(config["BUFFER_SECONDS"])
    ring_buffer = RingBuffer(buffer_seconds=buffer_seconds, sample_rate=16000)
    pipeline["ring_buffer"] = ring_buffer

    capture_path = os.path.join(os.path.dirname(__file__) or ".", "capture")
    process = subprocess.Popen(
        [capture_path, app_name],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    pipeline["capture_process"] = process

    pipeline["whisper_client"] = WhisperClient(
        endpoint=config["WHISPER_ENDPOINT"],
        model=config["WHISPER_MODEL"],
        api_key=config.get("WHISPER_API_KEY") or None,
    )

    pipeline["audio_encoder"] = AudioEncoder(sample_rate=16000, channels=1)

    pipeline["running"] = True

    pipeline["capture_thread"] = threading.Thread(
        target=capture_thread_fn, args=(process, ring_buffer), daemon=True
    )
    pipeline["whisper_thread"] = threading.Thread(
        target=whisper_thread_fn, args=(ring_buffer, pipeline["whisper_client"], config), daemon=True
    )
    pipeline["capture_thread"].start()
    pipeline["whisper_thread"].start()

    log.info(f"Pipeline started for: {app_name}")


def stop_pipeline():
    """Stop the audio capture and transcription pipeline."""
    pipeline["running"] = False

    if pipeline["capture_process"]:
        pipeline["capture_process"].terminate()
        pipeline["capture_process"].wait(timeout=5)
        pipeline["capture_process"] = None

    if pipeline["capture_thread"]:
        pipeline["capture_thread"].join(timeout=5)
        pipeline["capture_thread"] = None

    if pipeline["whisper_thread"]:
        pipeline["whisper_thread"].join(timeout=5)
        pipeline["whisper_thread"] = None

    pipeline["ring_buffer"] = None
    pipeline["whisper_client"] = None
    pipeline["audio_encoder"] = None

    log.info("Pipeline stopped")


async def broadcast_audio():
    """Read from ring buffer with delay, encode to WAV, broadcast to clients."""
    while not pipeline["running"]:
        await asyncio.sleep(0.1)

    ring_buffer = pipeline["ring_buffer"]
    encoder = pipeline["audio_encoder"]

    await asyncio.sleep(float(load_config()["CHUNK_SECONDS"]) + 1)

    reader = ring_buffer.create_reader()

    while pipeline["running"]:
        samples = reader.read(3200, block=False)
        if samples is None:
            await asyncio.sleep(0.01)
            continue

        try:
            wav_chunk = encoder.encode_wav_chunk(samples)
            if connected_clients:
                await asyncio.gather(
                    *[client.send(wav_chunk) for client in connected_clients],
                    return_exceptions=True,
                )
        except Exception as e:
            log.warning(f"Broadcast error: {e}")

        await asyncio.sleep(0.19)


async def broadcast_subtitles():
    """Forward subtitles from the queue to all WebSocket clients."""
    while True:
        try:
            subtitle = await asyncio.wait_for(
                pipeline["subtitle_queue"].get(), timeout=0.5
            )
            if connected_clients:
                msg = json.dumps(subtitle)
                await asyncio.gather(
                    *[client.send(msg) for client in connected_clients],
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
                app_name = data.get("source", "")
                if app_name:
                    config = load_config()
                    start_pipeline(app_name, config)
                    await websocket.send(json.dumps({"type": "status", "status": "capturing"}))
            elif data.get("type") == "stop":
                stop_pipeline()
                await websocket.send(json.dumps({"type": "status", "status": "stopped"}))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        log.info(f"Client disconnected ({len(connected_clients)} total)")


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
            asyncio.Future(),  # run forever
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
