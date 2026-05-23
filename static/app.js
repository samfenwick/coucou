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
    subtitles: [],
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

async function playAudioChunk(wavBytes) {
    const ctx = ensureAudioContext();

    try {
        // Decode WAV to PCM via Web Audio API
        const audioBuffer = await ctx.decodeAudioData(wavBytes.buffer.slice(0));

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

        const gain = ctx.createGain();
        gain.gain.value = state.volume;
        source.connect(gain);
        gain.connect(ctx.destination);

        // Schedule playback to maintain continuity
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
        // Word-level rendering for karaoke highlighting
        el.innerHTML = data.words
            .map((w, i) => `<span class="word" data-start="${w.start}" data-end="${w.end}">${w.word} </span>`)
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

        // Apply sync offset (convert ms to seconds)
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
            // Binary = WAV audio chunk
            playAudioChunk(new Uint8Array(event.data));
        } else {
            // Text = JSON (subtitle or status)
            const data = JSON.parse(event.data);
            if (data.type === "subtitle") {
                renderSubtitle(data);
            } else if (data.type === "status") {
                handleStatus(data.status);
            }
        }
    });

    state.ws.addEventListener("close", () => {
        $("#connection-status").textContent = "Disconnected";
        $("#connection-status").classList.remove("connected");
        // Auto-reconnect with exponential backoff
        setTimeout(() => {
            state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
            connect();
        }, state.reconnectDelay);
    });

    state.ws.addEventListener("error", () => {
        state.ws.close();
    });
}

function handleStatus(status) {
    if (status === "capturing") {
        state.capturing = true;
        $("#start-stop").textContent = "Stop";
        $("#subtitle-text").textContent = "Listening...";
        $("#subtitle-text").classList.add("inactive");
    } else if (status === "stopped") {
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
        const source = $("#source-select").value;
        if (!source) {
            alert("Select an audio source first");
            return;
        }
        // Ensure AudioContext is created on user gesture (iOS requirement)
        ensureAudioContext();
        state.ws.send(JSON.stringify({ type: "start", source }));
    }
});

$("#volume").addEventListener("input", (e) => {
    state.volume = parseInt(e.target.value, 10) / 100;
});

$("#sync-offset").addEventListener("input", (e) => {
    state.syncOffset = parseInt(e.target.value, 10);
    $("#sync-offset-label").textContent = `${state.syncOffset}ms`;
});

// --- Source List ---

async function loadSources() {
    const select = $("#source-select");
    try {
        const resp = await fetch("/api/sources");
        const sources = await resp.json();
        select.innerHTML = '<option value="">Select an app...</option>';
        for (const s of sources) {
            const opt = document.createElement("option");
            opt.value = s.name;
            opt.textContent = s.name;
            select.appendChild(opt);
        }
    } catch (err) {
        console.error("Failed to load sources:", err);
    }
}

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

$("#refresh-sources").addEventListener("click", loadSources);
loadSources();
connect();
requestWakeLock();
