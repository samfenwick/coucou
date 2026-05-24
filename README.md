<p align="center">
  <img src="static/logo.png" alt="Coucou" width="120">
</p>

<h1 align="center">Coucou</h1>

<p align="center">
  Real-time transcription, translation, and speaker diarization — running entirely on-device on Apple Silicon. No cloud, no API keys, no data leaves your Mac.
</p>

<p align="center"><strong>🚧 Work in progress — alpha quality, UX improvements coming</strong></p>

---

## What is it?

Coucou captures your Mac's system audio (or microphone), transcribes it in real-time with word-level timestamps, identifies speakers, translates to 20+ languages, and streams everything to any browser — all processed locally on your Mac's GPU via [MLX](https://github.com/ml-explore/mlx).

**Two interfaces:**
- **Viewer** (`localhost:8000`) — passive subtitle display with synced audio playback, word highlighting, and Picture-in-Picture support
- **Admin** (`localhost:8001`) — pipeline controls, mode switching, tuning, and live stats

## Use cases

- **Language learning** — watch French TV, YouTube, or podcasts with synced subtitles and live English translations
- **Conference calls** — start Coucou, share a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [Tailscale](https://tailscale.com/kb/1312/serve) link with participants, and everyone gets live captions with translations in their chosen language
- **Accessibility** — real-time captions for any audio playing on your Mac
- **Podcasts & music** — synced transcription of anything coming through your speakers

## Requirements

- **macOS** on **Apple Silicon** (M1/M2/M3/M4) — this is Mac-native only
- **Python 3.10+** and [uv](https://docs.astral.sh/uv/)
- **~5.6 GB disk space** for ML models (downloaded once, cached in `~/.cache/huggingface`)

## Setup

```bash
git clone https://github.com/samfenwick/coucou.git
cd coucou
./setup.sh
```

This installs:
- [BlackHole 2ch](https://existential.audio/blackhole/) — virtual audio device that captures system audio
- [SwitchAudioSource](https://github.com/deweller/switchaudio-osx) — programmatic audio routing
- Python dependencies
- All three ML models (pre-downloaded so first run is fast)

> **First time?** After installing BlackHole, you may need to **restart your Mac** and **allow the audio driver** in System Settings → Privacy & Security.

Then run:

```bash
uv run python server.py
```

Open [localhost:8000](http://localhost:8000) (viewer) and [localhost:8001](http://localhost:8001) (admin).

## Models

All models run on-device via MLX/Metal. They're downloaded automatically during setup.

| Model | Purpose | Size | Source |
|-------|---------|------|--------|
| [Voxtral Mini 4B](https://huggingface.co/mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit) | Speech-to-text transcription | ~3.2 GB | [Mistral AI](https://mistral.ai/) (Apache 2.0) |
| [Sortformer 4spk v2.1](https://huggingface.co/mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16) | Speaker diarization (up to 4 speakers) | ~236 MB | [NVIDIA NeMo](https://github.com/NVIDIA/NeMo) |
| [TranslateGemma 4B](https://huggingface.co/mlx-community/translategemma-4b-it-4bit_immersive-translate) | Translation (20+ languages) | ~2.2 GB | [Google](https://ai.google.dev/gemma) (Gemma license) |

No Hugging Face account or license acceptance is required to download these MLX community conversions.

> **Note:** Coucou's source code is MIT-licensed. The ML model weights (downloaded separately from Hugging Face) are subject to their own licenses: [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) (Voxtral), [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) (Sortformer), and [Gemma Terms of Use](https://ai.google.dev/gemma/terms) (TranslateGemma).

## Modes

| Mode | Latency | Best for |
|------|---------|----------|
| **Synced** | ~15–20s buffer | Watching video/TV — audio replays in sync with subtitles |
| **Realtime** | <1s | Live conversations, conference calls |

Switch between modes in the admin panel. Synced mode buffers audio so subtitles are perfectly timed with playback. Realtime mode streams subtitles as fast as possible with minimal delay.

## Remote access

The server runs plain HTTP. Browsers require HTTPS for audio APIs on non-localhost, so use a reverse proxy:

**Tailscale:**
```bash
tailscale serve --bg 8000
# https://<hostname>.ts.net/
```

**Cloudflare Tunnel:**
```bash
cloudflared tunnel --url http://localhost:8000
```

## Configuration

Copy `.env.example` to `.env` to customise. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHUNK_SECONDS` | `8` | Audio chunk size (higher = more accurate, more latency) |
| `OVERLAP_SECONDS` | `2` | Context overlap between chunks |
| `TRANSLATE` | `true` | Enable/disable translation |
| `DIARIZE` | `true` | Enable/disable speaker diarization |
| `TARGET_LANGUAGE` | `en` | Default translation target |

## Development

```bash
uv sync
uv run python -m pytest tests/
uv run python server.py
```

## License

[MIT](LICENSE)
