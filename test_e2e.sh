#!/usr/bin/env bash
set -e

echo "=== Subcurrent E2E Test ==="

# Check dependencies
echo "Checking dependencies..."
python3 -c "import websockets, numpy, httpx, sounddevice" || { echo "FAIL: Python deps missing"; exit 1; }
echo "  Python deps: OK"

# Check BlackHole
if ! python3 -c "import sounddevice as sd; assert any('BlackHole' in d['name'] for d in sd.query_devices())" 2>/dev/null; then
    echo "  WARNING: BlackHole not detected (install with: brew install blackhole-2ch)"
else
    echo "  BlackHole: OK"
fi

# Check SwitchAudioSource
if ! command -v SwitchAudioSource &>/dev/null; then
    echo "  WARNING: SwitchAudioSource not found (install with: brew install switchaudio-osx)"
else
    echo "  SwitchAudioSource: OK"
fi

# Run unit tests
echo ""
echo "Running unit tests..."
python3 -m pytest tests/ -v || { echo "FAIL: Unit tests"; exit 1; }
echo "  Unit tests: OK"

# Start server
echo ""
echo "Starting server..."
python3 server.py &
SERVER_PID=$!
sleep 2

# Test HTTP
echo "Testing HTTP..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/)
if [ "$STATUS" != "200" ]; then
    echo "FAIL: HTTP returned $STATUS"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi
echo "  GET /: OK"

# Test WebSocket
echo "Testing WebSocket..."
python3 -c "
import asyncio, websockets, json
async def test():
    async with websockets.connect('ws://localhost:8000') as ws:
        print('  WebSocket connection: OK')
asyncio.run(test())
" || { echo "FAIL: WebSocket"; kill $SERVER_PID 2>/dev/null; exit 1; }

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo ""
echo "=== All tests passed ==="
