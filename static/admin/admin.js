// Coucou Admin UI

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const LANG_FLAGS = {
    af:"🇿🇦",ar:"🇦🇪",bg:"🇧🇬",bn:"🇧🇩",ca:"🇪🇸",cs:"🇨🇿",da:"🇩🇰",de:"🇩🇪",
    el:"🇬🇷",en:"🇬🇧",es:"🇪🇸",fi:"🇫🇮",fr:"🇫🇷",hi:"🇮🇳",hr:"🇭🇷",hu:"🇭🇺",
    id:"🇮🇩",it:"🇮🇹",ja:"🇯🇵",ko:"🇰🇷",nl:"🇳🇱",no:"🇳🇴",pl:"🇵🇱",pt:"🇵🇹",
    ro:"🇷🇴",ru:"🇷🇺",sk:"🇸🇰",sv:"🇸🇪",th:"🇹🇭",tr:"🇹🇷",uk:"🇺🇦",vi:"🇻🇳",
    zh:"🇨🇳",
};

const MODE_HINTS = {
    synced: "Delayed audio, perfect word highlighting",
    realtime: "Passthrough audio, fast captions",
};

let ws = null;
let state = {
    running: false,
    mode: "synced",
    audio_source: "system",
    chunk_seconds: 10,
    overlap_seconds: 2,
};

// --- WebSocket ---

function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.addEventListener("open", () => {
        console.log("Admin connected");
    });

    ws.addEventListener("message", (e) => {
        const data = JSON.parse(e.data);
        if (data.type === "state") {
            applyState(data);
        } else if (data.type === "microphones") {
            populateMics(data.devices);
        }
    });

    ws.addEventListener("close", () => {
        setTimeout(connect, 2000);
    });

    ws.addEventListener("error", () => ws.close());
}

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// --- Apply state from server ---

function applyState(data) {
    state = { ...state, ...data };

    // Header
    const badge = $("#pipeline-status");
    const statusText = $("#status-text");
    const btn = $("#start-stop");
    if (data.status === "buffering") {
        badge.className = "status-badge buffering";
        statusText.textContent = "Buffering";
        btn.textContent = "Stop";
        btn.className = "btn-start running";
    } else if (data.running) {
        badge.className = "status-badge running";
        statusText.textContent = "Running";
        btn.textContent = "Stop";
        btn.className = "btn-start running";
    } else {
        badge.className = "status-badge stopped";
        statusText.textContent = "Stopped";
        btn.textContent = "Start";
        btn.className = "btn-start";
    }

    // Mode
    setSegmented("mode-toggle", data.mode || "synced");
    $("#mode-hint").textContent = MODE_HINTS[data.mode] || "";

    // Audio source
    setSegmented("source-toggle", data.audio_source || "system");
    const micPicker = $("#mic-picker");
    if (data.audio_source === "mic" || data.audio_source === "both") {
        micPicker.classList.add("active");
    } else {
        micPicker.classList.remove("active");
    }
    if (data.mic_device) {
        $("#mic-select").value = data.mic_device;
    }

    // Toggles
    $("#toggle-broadcast").checked = data.broadcast_audio ?? true;
    $("#toggle-translation").checked = data.translate_enabled ?? true;
    $("#toggle-diarization").checked = data.diarize_enabled ?? true;

    // Tuning  - disabled in realtime (streaming mode, no chunks)
    const isRealtime = (data.mode || "synced") === "realtime";
    state.chunk_seconds = data.chunk_seconds || 10;
    state.overlap_seconds = data.overlap_seconds || 2;
    $("#chunk-value").textContent = isRealtime ? "-" : `${state.chunk_seconds}s`;
    $("#overlap-value").textContent = isRealtime ? "-" : `${state.overlap_seconds}s`;
    $$(".step-btn").forEach(btn => btn.disabled = isRealtime);
    $("#tuning-section").classList.toggle("disabled", isRealtime);

    // Stats
    $("#stat-clients").textContent = data.clients ?? 0;
    $("#stat-buffer").innerHTML = data.running
        ? `${data.buffer_seconds ?? 0}<span class="stat-unit">s</span>`
        : ' -';
    const srcFlag = data.detected_language ? (LANG_FLAGS[data.detected_language] || data.detected_language) : "-";
    $("#stat-source").textContent = srcFlag;

    // Processing
    const proc = data.processing || {};
    $("#proc-transcription").textContent = data.running ? `${proc.transcription || 0}s` : "-";
    $("#proc-diarization").textContent = data.running ? `${proc.diarization || 0}s` : "-";

    // Translation processing rows
    const trRows = $("#translation-rows");
    trRows.innerHTML = "";
    const trTimes = proc.translations || {};
    for (const [lang, time] of Object.entries(trTimes)) {
        const row = document.createElement("div");
        row.className = "stat-row";
        row.innerHTML = `<span>Translation (${lang.toUpperCase()})</span><span>${time}s</span>`;
        trRows.appendChild(row);
    }

    // Translation summary
    const summary = $("#translation-summary");
    const counts = data.translations || {};
    if (Object.keys(counts).length === 0) {
        summary.textContent = "-";
    } else {
        summary.innerHTML = Object.entries(counts)
            .map(([lang, count]) => `${LANG_FLAGS[lang] || lang} <span style="color:#4a9eff;font-weight:600">${count}</span>`)
            .join("&nbsp;&nbsp;");
    }
}

function setSegmented(id, value) {
    const btns = $(`#${id}`).querySelectorAll(".seg-btn");
    btns.forEach(b => {
        b.classList.toggle("active", b.dataset.value === value);
    });
}

function populateMics(devices) {
    const select = $("#mic-select");
    select.innerHTML = '<option value="">Default</option>';
    for (const name of devices) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
}

// --- Controls ---

// Start/Stop
$("#start-stop").addEventListener("click", () => {
    send({ type: state.running ? "stop" : "start" });
});

// Mode toggle
$("#mode-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    send({ type: "mode", mode: btn.dataset.value });
});

// Audio source toggle
$("#source-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    const source = btn.dataset.value;
    send({
        type: "audio_source",
        source: source,
        device: (source === "mic" || source === "both") ? ($("#mic-select").value || null) : null,
    });
});

// Mic picker
$("#mic-select").addEventListener("change", (e) => {
    if (state.audio_source === "mic" || state.audio_source === "both") {
        send({ type: "audio_source", source: state.audio_source, device: e.target.value || null });
    }
});

// Pipeline toggles
["broadcast", "translation", "diarization"].forEach(feature => {
    const featureKey = feature === "broadcast" ? "broadcast_audio"
        : feature === "translation" ? "translate_enabled"
        : "diarize_enabled";
    $(`#toggle-${feature}`).addEventListener("change", (e) => {
        send({ type: "toggle", feature: featureKey, enabled: e.target.checked });
    });
});

// Stepper buttons
$$(".step-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const field = btn.dataset.field;
        const dir = parseInt(btn.dataset.dir);
        if (field === "chunk") {
            state.chunk_seconds = Math.max(3, Math.min(30, state.chunk_seconds + dir));
            $("#chunk-value").textContent = `${state.chunk_seconds}s`;
            send({ type: "tuning", chunk_seconds: state.chunk_seconds, overlap_seconds: state.overlap_seconds });
        } else if (field === "overlap") {
            state.overlap_seconds = Math.max(1, Math.min(10, state.overlap_seconds + dir));
            $("#overlap-value").textContent = `${state.overlap_seconds}s`;
            send({ type: "tuning", chunk_seconds: state.chunk_seconds, overlap_seconds: state.overlap_seconds });
        }
    });
});

// --- Init ---
connect();
