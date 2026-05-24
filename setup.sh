#!/usr/bin/env bash
set -e

echo "=== Coucou Setup ==="

# BlackHole virtual audio device (captures system audio)
if ! brew list blackhole-2ch &>/dev/null; then
    echo "Installing BlackHole 2ch..."
    brew install blackhole-2ch
    echo ""
    echo "⚠️  BlackHole installed  - you may need to restart your Mac and allow"
    echo "   the audio driver in System Settings > Privacy & Security."
    echo ""
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
    echo "Created .env from .env.example"
else
    echo ".env: already exists"
fi

# Pre-download ML models (~5.6 GB total, cached in ~/.cache/huggingface)
echo ""
echo "Downloading ML models (first run only)..."
uv run python -c "
from huggingface_hub import snapshot_download
models = [
    'mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit',
    'mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16',
    'mlx-community/translategemma-4b-it-4bit_immersive-translate',
]
for m in models:
    print(f'  Downloading {m}...')
    snapshot_download(m)
    print(f'  ✓ {m}')
print('All models downloaded.')
"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Run:  uv run python server.py"
echo ""
echo "Viewer:  http://localhost:8000"
echo "Admin:   http://localhost:8001"
