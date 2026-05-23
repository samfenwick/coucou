import subprocess
import logging

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

BLACKHOLE_DEVICE = "BlackHole 2ch"


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


class AudioCapture:
    """Captures system audio via BlackHole virtual audio device.

    On start: switches system output to BlackHole (silences speakers),
    captures from BlackHole, writes int16 samples to ring buffer.
    On stop: restores original audio output device.
    """

    def __init__(self, ring_buffer, sample_rate=16000):
        self._ring_buffer = ring_buffer
        self._sample_rate = sample_rate
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
            samplerate=self._sample_rate,
            dtype="float32",
            callback=self._callback,
            blocksize=640,
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
        samples = (indata[:, 0] * 32767).astype(np.int16)
        self._ring_buffer.write(samples)
