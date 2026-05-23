import subprocess
import logging

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

BLACKHOLE_DEVICE = "BlackHole 2ch"
CAPTURE_RATE = 48000  # native capture rate for quality playback
WHISPER_RATE = 16000  # Whisper expects 16kHz


def find_blackhole_index():
    """Find the BlackHole input device index."""
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        if BLACKHOLE_DEVICE in d["name"] and d["max_input_channels"] > 0:
            return i
    raise RuntimeError(f"{BLACKHOLE_DEVICE} not found. Run: brew install blackhole-2ch")


def get_current_output():
    """Get the current system audio output device name."""
    result = subprocess.run(
        ["SwitchAudioSource", "-c"],
        capture_output=True, text=True,
    )
    return result.stdout.strip()


def set_output(device_name):
    """Set the system audio output device."""
    subprocess.run(
        ["SwitchAudioSource", "-s", device_name],
        capture_output=True, text=True,
    )


def downsample_48_to_16(samples):
    """Downsample int16 samples from 48kHz to 16kHz (factor of 3)."""
    return samples[::3].copy()


class AudioCapture:
    """Captures system audio via BlackHole at 48kHz.

    Writes to two ring buffers:
    - playback_buffer: 48kHz for high-quality audio streaming
    - whisper_buffer: 16kHz downsampled for transcription
    """

    def __init__(self, playback_buffer, whisper_buffer):
        self._playback_buffer = playback_buffer
        self._whisper_buffer = whisper_buffer
        self._stream = None
        self._original_output = None

    def start(self):
        """Start capturing. Returns the original output device name."""
        device_index = find_blackhole_index()

        self._original_output = get_current_output()
        set_output(BLACKHOLE_DEVICE)
        log.info(f"Audio output switched to {BLACKHOLE_DEVICE} (was: {self._original_output})")

        self._stream = sd.InputStream(
            device=device_index,
            channels=1,
            samplerate=CAPTURE_RATE,
            dtype="float32",
            callback=self._callback,
            blocksize=1920,  # 40ms at 48kHz
        )
        self._stream.start()
        log.info("Audio capture started")

        return self._original_output

    def stop(self):
        """Stop capturing and restore original audio output."""
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None

        if self._original_output:
            set_output(self._original_output)
            log.info(f"Audio output restored to {self._original_output}")
            self._original_output = None

        log.info("Audio capture stopped")

    def _callback(self, indata, frames, time, status):
        if status:
            log.warning(f"Audio capture: {status}")

        samples_48k = (indata[:, 0] * 32767).astype(np.int16)
        self._playback_buffer.write(samples_48k)

        samples_16k = downsample_48_to_16(samples_48k)
        self._whisper_buffer.write(samples_16k)
