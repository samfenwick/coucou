import struct
import io
import numpy as np


class AudioEncoder:
    """Encodes PCM int16 samples for WebSocket streaming.

    Uses WAV containers for browser compatibility with decodeAudioData.
    Each chunk is a self-contained WAV file.
    """

    def __init__(self, sample_rate=16000, channels=1):
        self.sample_rate = sample_rate
        self.channels = channels

    def encode_wav_chunk(self, pcm_samples):
        """Wrap PCM int16 samples in a minimal WAV container."""
        data = pcm_samples.tobytes()
        data_size = len(data)
        bits_per_sample = 16

        buf = io.BytesIO()
        buf.write(b"RIFF")
        buf.write(struct.pack("<I", 36 + data_size))
        buf.write(b"WAVE")
        buf.write(b"fmt ")
        buf.write(struct.pack("<I", 16))
        buf.write(struct.pack("<H", 1))  # PCM
        buf.write(struct.pack("<H", self.channels))
        buf.write(struct.pack("<I", self.sample_rate))
        buf.write(struct.pack("<I", self.sample_rate * self.channels * bits_per_sample // 8))
        buf.write(struct.pack("<H", self.channels * bits_per_sample // 8))
        buf.write(struct.pack("<H", bits_per_sample))
        buf.write(b"data")
        buf.write(struct.pack("<I", data_size))
        buf.write(data)

        return buf.getvalue()
