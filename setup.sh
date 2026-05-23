#!/usr/bin/env bash
set -e

echo "=== Subcurrent Setup ==="

# BlackHole virtual audio device (captures system audio)
if ! brew list blackhole-2ch &>/dev/null; then
    echo "Installing BlackHole 2ch..."
    brew install blackhole-2ch
else
    echo "BlackHole 2ch: already installed"
fi

# SwitchAudioSource (programmatic audio device switching)
if ! command -v SwitchAudioSource &>/dev/null; then
    echo "Installing SwitchAudioSource..."
    brew install switchaudio-osx
else
    echo "SwitchAudioSource: already installed"
fi

# Python dependencies
echo "Installing Python dependencies..."
uv sync

# Create .env if missing
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example — edit it with your Whisper endpoint and API key"
else
    echo ".env: already exists"
fi

echo ""
echo "=== Setup complete ==="
echo "Run: uv run python server.py"
echo "Open: http://localhost:8000"
