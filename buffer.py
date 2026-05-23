import threading
import numpy as np


class BufferReader:
    """Independent reader with its own position into the ring buffer."""

    def __init__(self, ring_buffer):
        self._buf = ring_buffer
        self._position = ring_buffer.write_position

    def read(self, length, block=True):
        """Read `length` samples. Returns None if not enough data and block=False."""
        buf = self._buf
        available = buf.write_position - self._position
        if available < length:
            if not block:
                return None
            while buf.write_position - self._position < length:
                pass

        with buf._lock:
            start = self._position % buf._capacity
            end = start + length
            if end <= buf._capacity:
                result = buf._data[start:end].copy()
            else:
                part1 = buf._data[start:]
                part2 = buf._data[:end - buf._capacity]
                result = np.concatenate([part1, part2])

        self._position += length
        return result


class RingBuffer:
    """Thread-safe ring buffer for PCM audio samples (int16)."""

    def __init__(self, buffer_seconds, sample_rate=16000):
        self._capacity = buffer_seconds * sample_rate
        self._data = np.zeros(self._capacity, dtype=np.int16)
        self._lock = threading.Lock()
        self.write_position = 0
        self.sample_rate = sample_rate

    def create_reader(self):
        """Create a new independent reader starting at the current write position."""
        return BufferReader(self)

    def write(self, samples):
        """Write int16 samples into the ring buffer."""
        with self._lock:
            start = self.write_position % self._capacity
            end = start + len(samples)
            if end <= self._capacity:
                self._data[start:end] = samples
            else:
                split = self._capacity - start
                self._data[start:] = samples[:split]
                self._data[:len(samples) - split] = samples[split:]
            self.write_position += len(samples)

    def read_at(self, position, length):
        """Read `length` samples starting at absolute `position`."""
        oldest_available = max(0, self.write_position - self._capacity)
        if position < oldest_available or position + length > self.write_position:
            return None

        with self._lock:
            start = position % self._capacity
            end = start + length
            if end <= self._capacity:
                return self._data[start:end].copy()
            else:
                part1 = self._data[start:]
                part2 = self._data[:end - self._capacity]
                return np.concatenate([part1, part2])
