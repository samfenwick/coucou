#!/usr/bin/env bash
set -e

echo "=== Subcurrent E2E Test ==="

# Check dependencies
echo "Checking dependencies..."
python3 -c "import websockets, numpy, httpx" || { echo "FAIL: Python deps missing"; exit 1; }
echo "  Python deps: OK"

# Check capture tool
if [ ! -f "./capture" ]; then
    echo "  Compiling capture.swift..."
    swiftc capture.swift -o capture \
        -framework ScreenCaptureKit \
        -framework CoreMedia \
        -framework AVFoundation
fi
echo "  capture binary: OK"

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

# Test API
SOURCES=$(curl -s http://localhost:8000/api/sources)
if ! echo "$SOURCES" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    echo "FAIL: /api/sources not valid JSON"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi
echo "  GET /api/sources: OK"

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
