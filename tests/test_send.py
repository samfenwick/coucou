import asyncio
import sys
import types

import pytest


@pytest.fixture(scope="module")
def server():
    # server.py imports the MLX and audio stack at module level; stub it out.
    stubs = {
        "local_transcriber": {"LocalTranscriber": object, "StreamingTranscriber": object, "preload_model": lambda *a, **k: None},
        "audio_capture": {"AudioCapture": object},
        "diarize": {"create_diarizer": lambda c: None},
        "translator": {"create_translator": lambda c: None},
    }
    saved = {name: sys.modules.get(name) for name in stubs}
    for name, attrs in stubs.items():
        mod = types.ModuleType(name)
        mod.__dict__.update(attrs)
        sys.modules[name] = mod
    import server as srv
    yield srv
    for name, mod in saved.items():
        if mod is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = mod


class FakeTransport:
    def __init__(self, buffered, closing=False):
        self.buffered = buffered
        self.closing = closing

    def get_write_buffer_size(self):
        return self.buffered

    def is_closing(self):
        return self.closing


class FakeClient:
    """Mimics a websockets connection: send() waits forever once the buffer is past the high-water mark."""

    def __init__(self, buffered=0, closing=False):
        self.transport = FakeTransport(buffered, closing)
        self.sent = []

    async def send(self, msg):
        self.transport.buffered += len(msg)
        if self.transport.buffered > 2**15:
            await asyncio.Event().wait()
        self.sent.append(msg)


FRAME = b"\0" * 19208  # one 200ms audio chunk plus its header


@pytest.mark.parametrize("buffered", [0, 2**15 - len(FRAME)])
def test_sends_to_a_client_that_is_keeping_up(server, buffered):
    client = FakeClient(buffered)
    asyncio.run(server.send_to_viewers([client], FRAME))
    assert client.sent == [FRAME]


@pytest.mark.parametrize("client", [
    FakeClient(buffered=2**15 - len(FRAME) + 1),
    FakeClient(buffered=10 * 2**15),
    FakeClient(closing=True),
], ids=["would-pass-high-water", "stalled", "closing"])
def test_drops_for_a_client_that_is_not_reading(server, client):
    asyncio.run(asyncio.wait_for(server.send_to_viewers([client], FRAME), timeout=1))
    assert client.sent == []


def test_a_stalled_client_does_not_hold_up_the_others(server):
    stalled, healthy = FakeClient(buffered=10 * 2**15), FakeClient()
    asyncio.run(asyncio.wait_for(server.send_to_viewers([stalled, healthy], FRAME), timeout=1))
    assert healthy.sent == [FRAME]


class PingClient:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.transport = types.SimpleNamespace(aborted=False)
        self.transport.abort = lambda: setattr(self.transport, "aborted", True)

    async def ping(self):
        if self.behaviour == "closed":
            from websockets.exceptions import ConnectionClosedError
            raise ConnectionClosedError(None, None)
        if self.behaviour == "send-stuck":
            await asyncio.Event().wait()
        pong = asyncio.get_running_loop().create_future()
        if self.behaviour == "answers":
            pong.set_result(0.001)
        return pong


async def _watch(server, client, run_for):
    task = asyncio.create_task(server.drop_when_unresponsive(client, interval=0.01, timeout=0.05))
    await asyncio.wait([task], timeout=run_for)
    finished = task.done()
    task.cancel()
    return finished


@pytest.mark.parametrize("behaviour, aborted, finished", [
    ("answers", False, False),
    ("closed", False, True),
    ("no-pong", True, True),
    ("send-stuck", True, True),
])
def test_drops_a_viewer_that_stops_answering_pings(server, behaviour, aborted, finished):
    client = PingClient(behaviour)
    assert asyncio.run(_watch(server, client, run_for=0.3)) is finished
    assert client.transport.aborted is aborted
