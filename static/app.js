// Subcurrent — Web UI

const $ = (sel) => document.querySelector(sel);

const state = {
    ws: null,
    capturing: false,
    syncOffset: 0,
    audioCtx: null,
    nextPlayTime: 0,
    volume: 0.8,
    reconnectDelay: 1000,
};

// --- Audio Context + WAV Decoding ---

function ensureAudioContext() {
    if (!state.audioCtx) {
        state.audioCtx = new AudioContext({ sampleRate: 16000 });
    }
    if (state.audioCtx.state === "suspended") {
        state.audioCtx.resume();
    }
    return state.audioCtx;
}

async function routeAudioToDevice(deviceName) {
    // Route web app audio to the real speakers (not BlackHole)
    // so the user hears our buffered playback while system output is BlackHole
    const ctx = state.audioCtx;
    if (!ctx || !ctx.setSinkId) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputDevices = devices.filter(d => d.kind === "audiooutput");
        const target = outputDevices.find(d => d.label.includes(deviceName));
        if (target) {
            await ctx.setSinkId(target.deviceId);
            console.log(`Audio output routed to: ${target.label}`);
        } else {
            console.warn(`Output device "${deviceName}" not found, using default`);
        }
    } catch (err) {
        console.warn("setSinkId failed:", err);
    }
}

async function playAudioChunk(wavBytes) {
    const ctx = ensureAudioContext();

    try {
        const audioBuffer = await ctx.decodeAudioData(wavBytes.buffer.slice(0));

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

        const gain = ctx.createGain();
        gain.gain.value = state.volume;
        source.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;
        if (state.nextPlayTime < now) {
            state.nextPlayTime = now;
        }
        source.start(state.nextPlayTime);
        state.nextPlayTime += audioBuffer.duration;
    } catch (err) {
        console.warn("Audio decode error:", err);
    }
}

// --- Subtitle Rendering ---

function renderSubtitle(data) {
    const el = $("#subtitle-text");
    el.classList.remove("inactive");

    if (data.words && data.words.length > 0) {
        el.innerHTML = data.words
            .map((w) => `<span class="word" data-start="${w.start}" data-end="${w.end}">${w.word} </span>`)
            .join("");
        scheduleWordHighlighting(data.words);
    } else {
        el.textContent = data.text;
    }
}

function scheduleWordHighlighting(words) {
    if (!state.audioCtx) return;

    const baseTime = state.audioCtx.currentTime;

    for (const wordEl of document.querySelectorAll(".word")) {
        const start = parseFloat(wordEl.dataset.start);
        const end = parseFloat(wordEl.dataset.end);

        const offsetSec = state.syncOffset / 1000;
        const highlightAt = (start + offsetSec) - baseTime;
        const unhighlightAt = (end + offsetSec) - baseTime;

        if (highlightAt > 0) {
            setTimeout(() => wordEl.classList.add("active"), highlightAt * 1000);
        } else {
            wordEl.classList.add("active");
        }
        if (unhighlightAt > 0) {
            setTimeout(() => wordEl.classList.remove("active"), unhighlightAt * 1000);
        }
    }
}

// --- WebSocket ---

function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}`;

    state.ws = new WebSocket(wsUrl);
    state.ws.binaryType = "arraybuffer";

    state.ws.addEventListener("open", () => {
        $("#connection-status").textContent = "Connected";
        $("#connection-status").classList.add("connected");
        state.reconnectDelay = 1000;
    });

    state.ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
            playAudioChunk(new Uint8Array(event.data));
        } else {
            const data = JSON.parse(event.data);
            if (data.type === "subtitle") {
                renderSubtitle(data);
            } else if (data.type === "status") {
                handleStatus(data);
            }
        }
    });

    state.ws.addEventListener("close", () => {
        $("#connection-status").textContent = "Disconnected";
        $("#connection-status").classList.remove("connected");
        setTimeout(() => {
            state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
            connect();
        }, state.reconnectDelay);
    });

    state.ws.addEventListener("error", () => {
        state.ws.close();
    });
}

function handleStatus(data) {
    if (data.status === "capturing") {
        state.capturing = true;
        $("#start-stop").textContent = "Stop";
        $("#subtitle-text").textContent = "Listening...";
        $("#subtitle-text").classList.add("inactive");

        // Route audio to real speakers (system output is now BlackHole)
        if (data.outputDevice) {
            routeAudioToDevice(data.outputDevice);
        }
    } else if (data.status === "stopped") {
        state.capturing = false;
        $("#start-stop").textContent = "Start";
        $("#subtitle-text").textContent = "Waiting for audio...";
        $("#subtitle-text").classList.add("inactive");
    }
}

// --- Controls ---

$("#start-stop").addEventListener("click", () => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    if (state.capturing) {
        state.ws.send(JSON.stringify({ type: "stop" }));
    } else {
        ensureAudioContext();
        state.ws.send(JSON.stringify({ type: "start" }));
    }
});

$("#volume").addEventListener("input", (e) => {
    state.volume = parseInt(e.target.value, 10) / 100;
});

$("#sync-offset").addEventListener("input", (e) => {
    state.syncOffset = parseInt(e.target.value, 10);
    $("#sync-offset-label").textContent = `${state.syncOffset}ms`;
});

// --- Wake Lock (prevent screen sleep on mobile) ---

async function requestWakeLock() {
    if ("wakeLock" in navigator) {
        try {
            await navigator.wakeLock.request("screen");
        } catch (err) {
            console.warn("Wake lock failed:", err);
        }
    }
}

// --- Init ---

connect();
requestWakeLock();
