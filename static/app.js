// Subcurrent — Web UI

const $ = (sel) => document.querySelector(sel);

const state = {
    ws: null,
    capturing: false,
    audioDelay: 6000, // ms — server-side audio buffer delay
    audioCtx: null,
    nextPlayTime: 0,
    volume: 0.8,
    reconnectDelay: 1000,
};

// --- Audio output device picker ---

async function loadOutputDevices() {
    const select = $("#output-select");

    // Need mic permission to see device labels
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
    } catch (e) {
        // If denied, labels will be empty
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === "audiooutput" && !d.label.includes("BlackHole"));

    select.innerHTML = '<option value="">Select speakers...</option>';
    for (const d of outputs) {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || d.deviceId;
        select.appendChild(opt);
    }
}

async function routeToSelectedOutput() {
    const ctx = state.audioCtx;
    const deviceId = $("#output-select").value;
    if (!ctx || !ctx.setSinkId || !deviceId) return;

    try {
        await ctx.setSinkId(deviceId);
        console.log("Audio routed to:", $("#output-select").selectedOptions[0]?.textContent);
    } catch (err) {
        console.warn("setSinkId failed:", err);
    }
}

// --- Audio playback ---

async function playAudioChunk(wavBytes) {
    const ctx = state.audioCtx;
    if (!ctx || ctx.state === "closed") return;

    if (ctx.state === "suspended") {
        await ctx.resume();
    }

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

        const highlightAt = start - baseTime;
        const unhighlightAt = end - baseTime;

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
    } else if (data.status === "stopped") {
        state.capturing = false;
        $("#start-stop").textContent = "Start";
        $("#subtitle-text").textContent = "Waiting for audio...";
        $("#subtitle-text").classList.add("inactive");
    }
}

// --- Controls ---

$("#start-stop").addEventListener("click", async () => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    if (state.capturing) {
        state.ws.send(JSON.stringify({ type: "stop" }));
    } else {
        const outputDevice = $("#output-select").value;
        if (!outputDevice) {
            alert("Select a speaker output first");
            return;
        }

        // Create AudioContext on user gesture
        if (!state.audioCtx) {
            state.audioCtx = new AudioContext({ sampleRate: 48000 });
        }
        await state.audioCtx.resume();

        // Route to selected speakers before capture starts
        await routeToSelectedOutput();

        state.ws.send(JSON.stringify({ type: "start" }));
    }
});

$("#volume").addEventListener("input", (e) => {
    state.volume = parseInt(e.target.value, 10) / 100;
});

function updateSyncDisplay() {
    const secs = (state.audioDelay / 1000).toFixed(1);
    $("#sync-offset-label").textContent = `${secs}s`;
    $("#sync-offset").value = state.audioDelay;
}

function sendSyncToServer() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "sync", delay: state.audioDelay / 1000 }));
    }
}

$("#sync-offset").addEventListener("input", (e) => {
    state.audioDelay = parseInt(e.target.value, 10);
    updateSyncDisplay();
    sendSyncToServer();
});

$("#sync-reset").addEventListener("click", () => {
    state.audioDelay = 6000;
    updateSyncDisplay();
    sendSyncToServer();
});

$("#sync-minus").addEventListener("click", () => {
    state.audioDelay = Math.max(0, state.audioDelay - 100);
    updateSyncDisplay();
    sendSyncToServer();
});

$("#sync-plus").addEventListener("click", () => {
    state.audioDelay = Math.min(10000, state.audioDelay + 100);
    updateSyncDisplay();
    sendSyncToServer();
});

$("#refresh-outputs").addEventListener("click", loadOutputDevices);

// Also re-route when output device is changed mid-session
$("#output-select").addEventListener("change", () => {
    if (state.audioCtx) routeToSelectedOutput();
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
