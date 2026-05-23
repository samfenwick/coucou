import numpy as np
import threading
from buffer import RingBuffer


def test_write_and_read():
    """Write PCM data and read it back from a reader."""
    buf = RingBuffer(buffer_seconds=2, sample_rate=16000)
    reader = buf.create_reader()
    samples = np.zeros(8000, dtype=np.int16)
    buf.write(samples)
    result = reader.read(8000)
    assert result is not None
    assert len(result) == 8000
    np.testing.assert_array_equal(result, samples)


def test_read_blocks_when_empty():
    """Reader returns None when no data is available (non-blocking mode)."""
    buf = RingBuffer(buffer_seconds=2, sample_rate=16000)
    reader = buf.create_reader()
    result = reader.read(8000, block=False)
    assert result is None


def test_write_position_tracks_total_samples():
    """Write position counts total samples written, not ring position."""
    buf = RingBuffer(buffer_seconds=1, sample_rate=16000)
    samples = np.zeros(8000, dtype=np.int16)
    buf.write(samples)
    assert buf.write_position == 8000
    buf.write(samples)
    assert buf.write_position == 16000


def test_multiple_readers_independent():
    """Each reader tracks its own position independently."""
    buf = RingBuffer(buffer_seconds=2, sample_rate=16000)
    reader_a = buf.create_reader()
    reader_b = buf.create_reader()
    samples = np.zeros(8000, dtype=np.int16)
    buf.write(samples)
    reader_a.read(8000)
    assert reader_a.read(8000, block=False) is None
    result_b = reader_b.read(8000, block=False)
    assert result_b is not None
    assert len(result_b) == 8000


def test_wraps_around():
    """Data wraps around when buffer is full."""
    buf = RingBuffer(buffer_seconds=1, sample_rate=16000)
    reader = buf.create_reader()
    chunk = np.arange(8000, dtype=np.int16)
    buf.write(chunk)
    reader.read(8000)
    buf.write(chunk)
    buf.write(chunk)
    result = reader.read(16000)
    assert result is not None
    assert len(result) == 16000


def test_read_chunk_at_position():
    """Read a specific chunk by absolute position (for whisper overlap)."""
    buf = RingBuffer(buffer_seconds=5, sample_rate=16000)
    for i in range(3):
        chunk = np.full(16000, fill_value=i, dtype=np.int16)
        buf.write(chunk)
    result = buf.read_at(position=16000, length=16000)
    assert result is not None
    np.testing.assert_array_equal(result, np.full(16000, fill_value=1, dtype=np.int16))


def test_thread_safety():
    """Concurrent writes and reads don't corrupt data."""
    buf = RingBuffer(buffer_seconds=2, sample_rate=16000)
    reader = buf.create_reader()
    errors = []

    def writer():
        for i in range(100):
            chunk = np.full(160, fill_value=i % 32767, dtype=np.int16)
            buf.write(chunk)

    def reader_fn():
        total_read = 0
        while total_read < 16000:
            result = reader.read(160, block=False)
            if result is not None:
                total_read += len(result)

    t1 = threading.Thread(target=writer)
    t2 = threading.Thread(target=reader_fn)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    assert len(errors) == 0
