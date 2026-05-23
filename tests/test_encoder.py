import numpy as np
from encoder import AudioEncoder


def test_encode_wav_chunk_produces_valid_wav():
    """Encoding produces bytes starting with RIFF/WAVE header."""
    enc = AudioEncoder(sample_rate=16000, channels=1)
    pcm = np.zeros(320, dtype=np.int16)
    result = enc.encode_wav_chunk(pcm)
    assert isinstance(result, bytes)
    assert result[:4] == b"RIFF"
    assert result[8:12] == b"WAVE"


def test_encode_wav_chunk_correct_size():
    """WAV output has correct size: 44-byte header + data."""
    enc = AudioEncoder(sample_rate=16000, channels=1)
    pcm = np.zeros(320, dtype=np.int16)  # 640 bytes of PCM
    result = enc.encode_wav_chunk(pcm)
    assert len(result) == 44 + 640


def test_encode_wav_chunk_preserves_audio():
    """Encoded WAV data section matches input PCM bytes."""
    enc = AudioEncoder(sample_rate=16000, channels=1)
    pcm = np.arange(320, dtype=np.int16)
    result = enc.encode_wav_chunk(pcm)
    data_section = result[44:]
    decoded = np.frombuffer(data_section, dtype=np.int16)
    np.testing.assert_array_equal(decoded, pcm)
