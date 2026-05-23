import asyncio
import json
import os
import subprocess
import logging

import websockets
from websockets.asyncio.server import serve

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def load_config():
    """Load configuration from .env file."""
    config = {
        "WHISPER_ENDPOINT": "http://api.local.samfenwick.com/v1/audio/transcriptions",
        "WHISPER_MODEL": "whisper-v3-turbo",
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


async def handle_websocket(websocket):
    """Handle a WebSocket connection."""
    connected_clients.add(websocket)
    log.info(f"Client connected ({len(connected_clients)} total)")
    try:
        async for message in websocket:
            data = json.loads(message)
            log.info(f"Received: {data}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        log.info(f"Client disconnected ({len(connected_clients)} total)")


async def main():
    config = load_config()
    host = config["HOST"]
    port = int(config["PORT"])

    async with serve(
        handle_websocket,
        host,
        port,
        process_request=handle_http,
    ) as server:
        log.info(f"Server running at http://{host}:{port}")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
