// Coucou — Web UI

const $ = (sel) => document.querySelector(sel);

const LANG_FLAGS = {
    af: "\u{1F1FF}\u{1F1E6}", ar: "\u{1F1E6}\u{1F1EA}", bg: "\u{1F1E7}\u{1F1EC}", bn: "\u{1F1E7}\u{1F1E9}",
    ca: "\u{1F1EA}\u{1F1F8}", cs: "\u{1F1E8}\u{1F1FF}", da: "\u{1F1E9}\u{1F1F0}", de: "\u{1F1E9}\u{1F1EA}",
    el: "\u{1F1EC}\u{1F1F7}", en: "\u{1F1EC}\u{1F1E7}", es: "\u{1F1EA}\u{1F1F8}", fi: "\u{1F1EB}\u{1F1EE}",
    fr: "\u{1F1EB}\u{1F1F7}", hi: "\u{1F1EE}\u{1F1F3}", hr: "\u{1F1ED}\u{1F1F7}", hu: "\u{1F1ED}\u{1F1FA}",
    id: "\u{1F1EE}\u{1F1E9}", it: "\u{1F1EE}\u{1F1F9}", ja: "\u{1F1EF}\u{1F1F5}", ko: "\u{1F1F0}\u{1F1F7}",
    nl: "\u{1F1F3}\u{1F1F1}", no: "\u{1F1F3}\u{1F1F4}", pl: "\u{1F1F5}\u{1F1F1}", pt: "\u{1F1F5}\u{1F1F9}",
    ro: "\u{1F1F7}\u{1F1F4}", ru: "\u{1F1F7}\u{1F1FA}", sk: "\u{1F1F8}\u{1F1F0}", sv: "\u{1F1F8}\u{1F1EA}",
    th: "\u{1F1F9}\u{1F1ED}", tr: "\u{1F1F9}\u{1F1F7}", uk: "\u{1F1FA}\u{1F1E6}", vi: "\u{1F1FB}\u{1F1F3}",
    zh: "\u{1F1E8}\u{1F1F3}",
};

const state = {
    ws: null,
    capturing: false,
    audioCtx: null,
    nextPlayTime: 0,
    volume: 0.8,
    reconnectDelay: 1000,
    // Audio-subtitle sync: maps stream time → AudioContext time
    streamTimeBase: null,   // stream_time of first audio chunk
    audioCtxTimeBase: null, // audioCtx.currentTime when that chunk was scheduled
    translateEnabled: false,
    translateActive: true,  // user toggle (persisted locally)
    wordHighlight: localStorage.getItem("subcurrent-word-highlight") !== "false", // on by default
    translationHighlight: localStorage.getItem("subcurrent-tr-highlight") === "true",
    showOriginal: localStorage.getItem("subcurrent-show-original") !== "false", // on by default
    targetLanguage: "en",
};

// --- Settings drawer ---

function openSettings() {
    $("#settings-drawer").classList.remove("drawer-hidden");
}

function closeSettings() {
    $("#settings-drawer").classList.add("drawer-hidden");
}

$("#settings-toggle").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", closeSettings);
$("#settings-backdrop").addEventListener("click", closeSettings);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
});

// --- Audio output device picker ---

async function loadOutputDevices() {
    const select = $("#output-select");

    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        select.innerHTML = '<option value="default">Default output</option>';
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
    } catch (e) {
        // If denied, labels will be empty
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === "audiooutput" && !d.label.includes("BlackHole"));

    if (outputs.length === 0) {
        select.innerHTML = '<option value="default">Default output</option>';
        return;
    }

    select.innerHTML = '<option value="default">Default output</option>';
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
    } catch (err) {
        console.warn("setSinkId failed:", err);
    }
}

// --- Audio playback ---

function handleAudioSync(streamTime) {
    // Record mapping: this stream_time corresponds to the next audio play time
    if (state.audioCtx && state.nextPlayTime > 0) {
        const wasNull = state.streamTimeBase == null;
        state.streamTimeBase = streamTime;
        state.audioCtxTimeBase = state.nextPlayTime;
        // Sync just established — flush any queued subtitles with corrected timing
        if (wasNull && subtitleQueue.length > 0) {
            for (const item of subtitleQueue) {
                item.showAt = item.data.start ? streamTimeToWallClock(item.data.start) : Date.now();
            }
            // Drop subtitles whose audio has already played
            while (subtitleQueue.length > 0 && subtitleQueue[0].showAt < Date.now() - 2000) {
                subtitleQueue.shift();
            }
            if (!animationId && !showTimer) scheduleNext();
        }
    }
}

function streamTimeToWallClock(streamTime) {
    // Convert a stream timestamp to a wall clock time (Date.now()) for display
    if (state.streamTimeBase == null || !state.audioCtx) return Date.now();
    const audioCtxTarget = state.audioCtxTimeBase + (streamTime - state.streamTimeBase);
    const secsFromNow = audioCtxTarget - state.audioCtx.currentTime;
    return Date.now() + secsFromNow * 1000;
}

function ensureGainNode() {
    if (!state.audioCtx || state.gainNode) return;
    state.gainNode = state.audioCtx.createGain();
    state.gainNode.gain.value = state.volume;
    state.gainNode.connect(state.audioCtx.destination);
}

function setVolume(vol) {
    state.volume = vol;
    if (state.gainNode) {
        state.gainNode.gain.value = vol;
    }
}

function playAudioChunk(rawBytes) {
    const ctx = state.audioCtx;
    if (!ctx || ctx.state === "closed") return;

    if (ctx.state === "suspended") {
        ctx.resume();
    }

    ensureGainNode();

    try {
        // Raw PCM int16 mono 48kHz — convert to float32 directly (no async decode)
        const int16 = new Int16Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 2);
        const numSamples = int16.length;
        const audioBuffer = ctx.createBuffer(1, numSamples, 48000);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < numSamples; i++) {
            channel[i] = int16[i] / 32768;
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(state.gainNode);

        const now = ctx.currentTime;
        if (state.nextPlayTime < now) {
            state.nextPlayTime = now;
        }
        // Cap scheduling buffer to 150ms — drop audio rather than accumulate latency
        if (state.nextPlayTime > now + 0.15) {
            state.nextPlayTime = now;
        }
        source.start(state.nextPlayTime);
        state.nextPlayTime += audioBuffer.duration;

        if (!state._audioLogDone) {
            console.log(`Audio playing: ctx.state=${ctx.state}, sinkId=${ctx.sinkId}, vol=${state.volume}, dur=${audioBuffer.duration.toFixed(3)}s, samples=${numSamples}`);
            state._audioLogDone = true;
        }
    } catch (err) {
        console.warn("Audio playback error:", err);
    }
}

// --- Subtitle Rendering (queue + requestAnimationFrame) ---

const subtitleQueue = [];
let animationId = null;
let showTimer = null;

function clearSubtitles() {
    subtitleQueue.length = 0;
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    $("#subtitle-text").textContent = "";
    $("#translation-text").textContent = "";
    syncPipSubtitles(true, "");
}

let lastFinalTime = 0;
let staleTimer = null;

function clearStaleSubtitle() {
    const el = $("#subtitle-text");
    el.textContent = "";
    el.style.display = "";
    $("#translation-text").innerHTML = "";
    $("#subtitle-container").classList.remove("translating");
    syncPipSubtitles(true, "");
}

function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    // Clear subtitle after 8s of no new content
    staleTimer = setTimeout(clearStaleSubtitle, 8000);
}

function showPartialSubtitle(text) {
    // Don't let a partial overwrite a recent final (which has translation)
    if (Date.now() - lastFinalTime < 2000) return;
    // Cancel any in-progress final subtitle animation
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    // Flush any stale queued subtitles — partial represents current state
    subtitleQueue.length = 0;
    const el = $("#subtitle-text");
    el.style.display = "";
    el.classList.remove("inactive");
    el.textContent = text;
    // Hide translation during partials (translation comes with final)
    $("#translation-text").innerHTML = "";
    $("#subtitle-container").classList.remove("translating");
    syncPipSubtitles(false, null, null);
    resetStaleTimer();
}

function enqueueSubtitle(data) {
    if (state.streamTimeBase == null) {
        // No audio sync (broadcast_audio off or not yet established) —
        // show immediately, bypass queue to avoid race with partials
        presentSubtitle(data);
        return;
    }

    // Sync to audio playback: show subtitle when its audio actually plays
    const showAt = data.start ? streamTimeToWallClock(data.start) : Date.now();

    // Drop stale queued entries (showAt already past) — keep only the most recent one
    const now = Date.now();
    const stale = [];
    subtitleQueue.forEach(q => { if (q.showAt <= now) stale.push(q); });
    if (stale.length > 0) {
        // Remove all stale except keep the newest one to show immediately
        subtitleQueue.length = 0;
    }

    subtitleQueue.push({ data, showAt });

    // Kick off processing if idle
    if (!animationId && !showTimer) scheduleNext();
}

function scheduleNext() {
    if (subtitleQueue.length === 0) {
        animationId = null;
        showTimer = null;
        return;
    }

    // Skip stale entries — only show the most recent past-due one
    const now = Date.now();
    while (subtitleQueue.length > 1 && subtitleQueue[0].showAt <= now) {
        subtitleQueue.shift();
    }

    const next = subtitleQueue.shift();
    const delay = Math.max(0, next.showAt - now);

    showTimer = setTimeout(() => {
        showTimer = null;
        presentSubtitle(next.data);
    }, delay);
}

function renderWordsHtml(words, dimmed) {
    const opacity = dimmed ? ' style="opacity:0.4"' : '';
    const speakerIds = new Set(words.filter(w => w.speaker != null).map(w => w.speaker));
    const hasMultipleSpeakers = speakerIds.size >= 2;

    if (hasMultipleSpeakers) {
        const rows = [];
        let currentSpeaker = null;
        let currentRow = null;
        for (const w of words) {
            const spk = w.speaker ?? 0;
            if (spk !== currentSpeaker) {
                currentSpeaker = spk;
                currentRow = { speaker: spk, words: [] };
                rows.push(currentRow);
            }
            currentRow.words.push(w);
        }
        return rows
            .map((row) => {
                const wordsHtml = row.words
                    .map((w) => `<span class="word">${w.word} </span>`)
                    .join("");
                return `<div class="speaker-row speaker-${row.speaker % 5}"${opacity}>${wordsHtml}</div>`;
            })
            .join("");
    } else {
        return `<div${opacity}>${words.map((w) => `<span class="word">${w.word} </span>`).join("")}</div>`;
    }
}

function updateLangBar(detectedLang) {
    if (!state.translateEnabled || !detectedLang) return;
    const flag = LANG_FLAGS[detectedLang] || "";
    $("#translate-toggle").textContent = `${flag} ${detectedLang.toUpperCase()}`;

    // Sync PiP language bar
    if (pipWindow) {
        const pipDetected = pipWindow.document.getElementById("pip-lang-detected");
        if (pipDetected) pipDetected.textContent = `${flag} ${detectedLang.toUpperCase()}`;
    }
}

function showTranslation(translation) {
    const el = $("#translation-text");
    const container = $("#subtitle-container");
    if (translation && state.translateActive) {
        if (state.translationHighlight) {
            // Wrap each word in a span for karaoke highlighting
            el.innerHTML = translation.split(/\s+/).map(w =>
                `<span class="tr-word">${w}</span>`
            ).join(" ");
        } else {
            el.textContent = translation;
        }
        container.classList.add("translating");
    } else {
        el.innerHTML = "";
        container.classList.remove("translating");
    }
}

function presentSubtitle(data) {
    // Cancel any in-progress animation (e.g. provisional being replaced by final)
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    const el = $("#subtitle-text");
    el.classList.remove("inactive");

    // Update language bar and translation
    updateLangBar(data.detected_language);
    const activeTranslation = state.translateActive ? data.translation : null;
    const hideOriginal = !state.showOriginal && activeTranslation;
    showTranslation(activeTranslation);
    if (data.translation) lastFinalTime = Date.now();
    resetStaleTimer();

    if (!data.words || data.words.length === 0) {
        if (hideOriginal) {
            el.textContent = "";
            el.style.display = "none";
        } else {
            el.style.display = "";
            el.textContent = data.text;
        }
        syncPipSubtitles(false, null, activeTranslation);
        showTimer = setTimeout(scheduleNext, 3000);
        return;
    }

    // Show just the current chunk with word highlighting
    if (hideOriginal) {
        el.innerHTML = "";
        el.style.display = "none";
    } else {
        el.style.display = "";
        const html = renderWordsHtml(data.words, false);
        el.innerHTML = html;
    }
    syncPipSubtitles(false, null, activeTranslation);

    const wordEls = el.querySelectorAll(".word");
    const pipWordEls = pipWindow ? pipWindow.document.querySelectorAll("#pip-content .word") : [];
    // Translation word elements for proportional highlighting
    const trWordEls = state.translationHighlight ? $("#translation-text").querySelectorAll(".tr-word") : [];
    const pipTrWordEls = state.translationHighlight && pipWindow ? pipWindow.document.querySelectorAll("#pip-translation .tr-word") : [];
    const firstStart = data.words[0].start;
    const lastEnd = data.words[data.words.length - 1].end;
    const totalMs = (lastEnd - firstStart) * 1000;
    let prevIdx = -1;
    let prevTrIdx = -1;
    let startTs = null;

    function step(ts) {
        if (!startTs) startTs = ts;
        const elapsed = ts - startTs;

        for (let i = prevIdx + 1; i < data.words.length; i++) {
            const wordStart = (data.words[i].start - firstStart) * 1000;
            if (elapsed >= wordStart) {
                // Original word highlighting (blue)
                if (state.wordHighlight) {
                    if (prevIdx >= 0) {
                        wordEls[prevIdx].classList.remove("active");
                        if (pipWordEls[prevIdx]) pipWordEls[prevIdx].classList.remove("active");
                    }
                    wordEls[i].classList.add("active");
                    if (pipWordEls[i]) pipWordEls[i].classList.add("active");
                }
                prevIdx = i;

                // Proportional translation highlighting (amber)
                if (trWordEls.length > 0) {
                    const progress = (i + 1) / data.words.length;
                    const trIdx = Math.min(Math.floor(progress * trWordEls.length), trWordEls.length - 1);
                    if (trIdx !== prevTrIdx) {
                        if (prevTrIdx >= 0) {
                            trWordEls[prevTrIdx].classList.remove("active");
                            if (pipTrWordEls[prevTrIdx]) pipTrWordEls[prevTrIdx].classList.remove("active");
                        }
                        trWordEls[trIdx].classList.add("active");
                        if (pipTrWordEls[trIdx]) pipTrWordEls[trIdx].classList.add("active");
                        prevTrIdx = trIdx;
                    }
                }
            } else {
                break;
            }
        }

        if (elapsed < totalMs) {
            animationId = requestAnimationFrame(step);
        } else {
            if (state.wordHighlight && prevIdx >= 0) {
                wordEls[prevIdx].classList.remove("active");
                if (pipWordEls[prevIdx]) pipWordEls[prevIdx].classList.remove("active");
            }
            if (prevTrIdx >= 0 && trWordEls[prevTrIdx]) {
                trWordEls[prevTrIdx].classList.remove("active");
                if (pipTrWordEls[prevTrIdx]) pipTrWordEls[prevTrIdx].classList.remove("active");
            }
            animationId = null;
            scheduleNext();
        }
    }

    animationId = requestAnimationFrame(step);
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
                enqueueSubtitle(data);
            } else if (data.type === "partial") {
                showPartialSubtitle(data.text);
            } else if (data.type === "audio_sync") {
                handleAudioSync(data.stream_time);
            } else if (data.type === "status") {
                handleStatus(data);
            } else if (data.type === "settings") {
                applyServerSettings(data);
            } else if (data.type === "sync_reset") {
                // Settings changed — reset sync state so subtitles recalibrate
                state.streamTimeBase = null;
                state.audioCtxTimeBase = null;
                state.nextPlayTime = 0;
                clearSubtitles();
            }
        }
    });

    state.ws.addEventListener("close", () => {
        $("#connection-status").textContent = "Disconnected";
        state.capturing = false;
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
    const bs = $("#broadcast-status");
    if (data.status === "capturing") {
        state.capturing = true;
        if (!state.audioCtx) {
            state.audioCtx = new AudioContext({ sampleRate: 48000 });
        }
        if (navigator.audioSession) {
            navigator.audioSession.type = "playback";
        }
        state.audioCtx.resume();
        $("#subtitle-text").innerHTML = '<span class="buffer-label">Listening...</span>';
        $("#subtitle-text").classList.add("inactive");
        bs.textContent = "Broadcasting";
        bs.className = "broadcasting";
        if (data.outputDevice) {
            autoRouteToOriginalOutput(data.outputDevice);
        }
    } else if (data.status === "buffering") {
        state.capturing = !data.broadcast_audio; // subtitles-only mode is immediately ready
        // Reset sync state for clean restart
        state.nextPlayTime = 0;
        state.streamTimeBase = null;
        state.audioCtxTimeBase = null;
        if (state.gainNode) {
            try { state.gainNode.disconnect(); } catch(e) {}
            state.gainNode = null;
        }
        clearSubtitles();
        if (data.broadcast_audio === false) {
            // No audio to buffer — show "Listening..." immediately
            $("#subtitle-text").innerHTML = '<span class="buffer-label">Listening...</span>';
            $("#subtitle-text").classList.add("inactive");
            bs.textContent = "Subtitles Only";
            bs.className = "broadcasting";
        } else {
            if (state.audioCtx && state.audioCtx.state !== "closed") {
                state.audioCtx.resume();
            }
            $("#subtitle-text").innerHTML = '<span class="buffer-label">Buffering...</span>';
            $("#subtitle-text").classList.add("inactive");
            bs.textContent = "Buffering";
            bs.className = "buffering";
            if (data.outputDevice) {
                autoRouteToOriginalOutput(data.outputDevice);
            }
        }
    } else if (data.status === "stopped") {
        state.capturing = false;
        $("#subtitle-text").textContent = "Waiting for audio...";
        $("#subtitle-text").classList.add("inactive");
        bs.textContent = "Not Broadcasting";
        bs.className = "";
        syncPipSubtitles(true, "Waiting for audio...");
        clearSubtitles();
        state.nextPlayTime = 0;
        state.streamTimeBase = null;
        state.audioCtxTimeBase = null;
        if (state.audioCtx && state.audioCtx.state !== "closed") {
            state.audioCtx.suspend();
        }
    }
}

// --- Apply server settings on connect ---

function applyServerSettings(data) {
    // Restore saved target language preference over server default
    const savedLang = localStorage.getItem("coucou-target-lang");
    if (savedLang) {
        state.targetLanguage = savedLang;
        $("#target-lang").value = savedLang;
        // Tell server about our saved preference
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: "config", target_language: savedLang }));
        }
    } else if (data.target_language != null) {
        state.targetLanguage = data.target_language;
        $("#target-lang").value = data.target_language;
    }
    if (data.translate_enabled != null) {
        state.translateEnabled = data.translate_enabled;
        updateTranslateBarUI();
    }
}

// --- Controls ---

async function autoRouteToOriginalOutput(deviceName) {
    // When capturing starts, system output switches to BlackHole.
    // Route browser audio to the original output device by matching label.
    // Skip if user has manually chosen a device.
    const ctx = state.audioCtx;
    if (!ctx || !ctx.setSinkId || !deviceName) return;

    const saved = localStorage.getItem("subcurrent-output-device");
    if (saved && saved !== "default") {
        // User previously picked a specific device — respect that choice
        try {
            await ctx.setSinkId(saved);
            console.log("Routed audio to saved device:", saved);
            // Select it in the picker
            const select = $("#output-select");
            if (select.querySelector(`option[value="${saved}"]`)) {
                select.value = saved;
            }
        } catch (err) {
            console.warn("setSinkId (saved) failed, falling back:", err);
        }
        return;
    }

    // No saved preference — auto-route to the server's original output device
    const devices = await navigator.mediaDevices.enumerateDevices();
    const match = devices.find(d =>
        d.kind === "audiooutput" && d.label.includes(deviceName)
    );
    if (match) {
        try {
            await ctx.setSinkId(match.deviceId);
            console.log("Auto-routed audio to:", match.label);
            // Update the picker to reflect the auto-selected device
            const select = $("#output-select");
            if (select.querySelector(`option[value="${match.deviceId}"]`)) {
                select.value = match.deviceId;
            }
        } catch (err) {
            console.warn("setSinkId failed:", err);
        }
    }
}

// Volume
$("#volume").addEventListener("input", (e) => {
    setVolume(parseInt(e.target.value, 10) / 100);
    localStorage.setItem("subcurrent-volume", e.target.value);
});

// Font size (per-client, saved locally)
function applyFontSize(size) {
    document.documentElement.style.setProperty("--subtitle-size", `${size}px`);
    $("#font-size").value = size;
    $("#font-size-label").textContent = `${size}px`;
}

$("#font-size").addEventListener("input", (e) => {
    applyFontSize(e.target.value);
    localStorage.setItem("subcurrent-font-size", e.target.value);
});

// Show original toggle
const showOriginalEl = $("#show-original-toggle");
showOriginalEl.checked = state.showOriginal;
showOriginalEl.addEventListener("change", (e) => {
    state.showOriginal = e.target.checked;
    localStorage.setItem("subcurrent-show-original", e.target.checked ? "true" : "false");
});

// Karaoke highlight toggles
const wordHighlightEl = $("#word-highlight-toggle");
wordHighlightEl.checked = state.wordHighlight;
wordHighlightEl.addEventListener("change", (e) => {
    state.wordHighlight = e.target.checked;
    localStorage.setItem("subcurrent-word-highlight", e.target.checked ? "true" : "false");
});

const trHighlightEl = $("#translation-highlight-toggle");
trHighlightEl.checked = state.translationHighlight;
trHighlightEl.addEventListener("change", (e) => {
    state.translationHighlight = e.target.checked;
    localStorage.setItem("subcurrent-tr-highlight", e.target.checked ? "true" : "false");
});

// Volume (per-client, saved locally)
function applyVolume(vol) {
    setVolume(vol / 100);
    $("#volume").value = vol;
}

// Restore saved client settings
const savedFontSize = localStorage.getItem("subcurrent-font-size");
if (savedFontSize) applyFontSize(savedFontSize);
const savedVolume = localStorage.getItem("subcurrent-volume");
if (savedVolume) applyVolume(savedVolume);
const savedTranslate = localStorage.getItem("coucou-translate-active");
if (savedTranslate !== null) state.translateActive = savedTranslate === "1";
// Set a default source flag until first detection
$("#translate-toggle").textContent = "\u{1F30D}";

// Translate toggle — click the flag bar to toggle translations on/off
function updateTranslateBarUI() {
    const bar = $("#translate-bar");
    if (!state.translateEnabled) {
        bar.style.display = "none";
        return;
    }
    bar.style.display = "flex";
    if (state.translateActive) {
        bar.classList.remove("disabled");
    } else {
        bar.classList.add("disabled");
    }
    const container = $("#subtitle-container");
    if (state.translateActive && $("#translation-text").textContent) {
        container.classList.add("translating");
    } else {
        container.classList.remove("translating");
    }
}

$("#translate-toggle").addEventListener("click", () => {
    state.translateActive = !state.translateActive;
    localStorage.setItem("coucou-translate-active", state.translateActive ? "1" : "0");
    updateTranslateBarUI();
    if (!state.translateActive) {
        $("#translation-text").textContent = "";
        $("#subtitle-container").classList.remove("translating");
    }
});

// Target language
$("#target-lang").addEventListener("change", (e) => {
    state.targetLanguage = e.target.value;
    localStorage.setItem("coucou-target-lang", e.target.value);
    // Sync PiP picker
    if (pipWindow) {
        const pipSelect = pipWindow.document.getElementById("pip-target-lang");
        if (pipSelect) pipSelect.value = e.target.value;
    }
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: "config",
            target_language: e.target.value,
        }));
    }
});

// Output device
$("#refresh-outputs").addEventListener("click", loadOutputDevices);
$("#output-select").addEventListener("change", () => {
    localStorage.setItem("subcurrent-output-device", $("#output-select").value);
    if (state.audioCtx) routeToSelectedOutput();
});

// --- Wake Lock ---

async function requestWakeLock() {
    if ("wakeLock" in navigator) {
        try {
            await navigator.wakeLock.request("screen");
        } catch (err) {
            console.warn("Wake lock failed:", err);
        }
    }
}

// --- Picture-in-Picture ---

let pipWindow = null;

async function openPiP() {
    if (!("documentPictureInPicture" in window)) {
        console.warn("Document PiP not supported");
        return;
    }
    if (pipWindow) {
        pipWindow.close();
        pipWindow = null;
        return;
    }

    pipWindow = await documentPictureInPicture.requestWindow({
        width: 640,
        height: 300,
    });

    pipWindow.document.head.innerHTML = `<style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0a0a0a; color: #e8e8e8;
            display: flex; flex-direction: column;
            height: 100vh; overflow: hidden;
            -webkit-user-select: none; user-select: none;
        }
        #pip-subs {
            flex: 1; display: flex; flex-direction: column;
            justify-content: center; align-items: center;
            padding: 0.5rem 0.75rem; overflow: hidden;
            min-height: 0;
        }
        #pip-content {
            text-align: center; line-height: 1.5; width: 100%;
        }
        #pip-content.inactive { color: #666; font-size: 13px; font-style: italic; }
        /* When translating: both lines equal size, color differentiated */
        #pip-subs.translating #pip-content {
            color: #e8e8e8;
        }
        #pip-translation {
            line-height: 1.3; margin-top: 0.3rem;
            text-align: center; width: 100%; color: #aabbcc;
        }
        #pip-translation:empty { display: none; }
        .tr-word { display: inline; transition: color 0.15s ease, text-shadow 0.15s ease; }
        .tr-word.active { color: #ffaa44; text-shadow: 0 0 12px rgba(255,170,68,0.3); }
        .word { display: inline; transition: color 0.15s ease, text-shadow 0.15s ease; }
        .word.active { color: #4a9eff; text-shadow: 0 0 12px rgba(74,158,255,0.3); }
        .speaker-row { border-left: 2px solid #666; padding-left: 0.5rem; margin-bottom: 0.3rem; text-align: left; }
        .speaker-row:last-child { margin-bottom: 0; }
        .speaker-0 { border-left-color: #4a9eff; }
        .speaker-0 .word.active { color: #4a9eff; }
        .speaker-1 { border-left-color: #4adf8a; }
        .speaker-1 .word.active { color: #4adf8a; }
        .speaker-2 { border-left-color: #f0a050; }
        .speaker-2 .word.active { color: #f0a050; }
        .speaker-3 { border-left-color: #e06088; }
        .speaker-3 .word.active { color: #e06088; }
        #pip-bar {
            display: flex; align-items: center; gap: 0.5rem;
            padding: 0.4rem 0.75rem; background: #141414;
            border-top: 1px solid #2a2a2a; flex-shrink: 0;
        }
        #pip-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: #ff4444; flex-shrink: 0;
        }
        #pip-dot.connected { background: #44ff44; }
        #pip-vol { width: 80px; accent-color: #4a9eff; height: 3px; cursor: pointer; }
        #pip-mute {
            background: none; border: none; color: #e8e8e8;
            font-size: 0.85rem; cursor: pointer; padding: 0; line-height: 1;
        }
        .pip-lang-bar {
            display: flex; align-items: center; gap: 0.4rem;
            font-size: 0.65rem; color: #888; margin-left: auto;
        }
        .pip-lang-bar select {
            background: #0a0a0a; color: #e8e8e8; border: 1px solid #2a2a2a;
            border-radius: 3px; padding: 0.1rem 0.3rem; font-size: 0.65rem;
            font-family: inherit; font-weight: 600; cursor: pointer;
        }
        .pip-lang-arrow { opacity: 0.5; }
    </style>`;

    // Build target language options
    const langOptions = ["en","fr","es","de","it","pt","nl","pl","ru","ja","ko","zh","ar","hi","sv","da","no","tr","uk","cs"]
        .map(c => `<option value="${c}"${c === state.targetLanguage ? " selected" : ""}>${c.toUpperCase()}</option>`)
        .join("");

    pipWindow.document.body.innerHTML = `
        <div id="pip-subs">
            <div id="pip-content" class="inactive">Waiting for audio...</div>
            <div id="pip-translation"></div>
        </div>
        <div id="pip-bar">
            <div id="pip-dot"></div>
            <button id="pip-mute">${state.volume === 0 ? "\u{1F507}" : "\u{1F50A}"}</button>
            <input type="range" id="pip-vol" min="0" max="100" value="${Math.round(state.volume * 100)}">
            <div class="pip-lang-bar" id="pip-lang-bar" style="display:${state.translateEnabled ? "flex" : "none"}">
                <span id="pip-lang-detected"></span>
                <span class="pip-lang-arrow">\u2192</span>
                <select id="pip-target-lang">${langOptions}</select>
            </div>
        </div>
    `;

    const pipDoc = pipWindow.document;

    // Volume control
    pipDoc.getElementById("pip-vol").addEventListener("input", (e) => {
        setVolume(parseInt(e.target.value, 10) / 100);
        $("#volume").value = e.target.value;
        localStorage.setItem("subcurrent-volume", e.target.value);
        pipDoc.getElementById("pip-mute").textContent = state.volume === 0 ? "\u{1F507}" : "\u{1F50A}";
    });

    // Mute toggle
    pipDoc.getElementById("pip-mute").addEventListener("click", () => {
        if (state.volume > 0) {
            preMuteVolume = state.volume;
            setVolume(0);
        } else {
            setVolume(preMuteVolume);
        }
        const val = Math.round(state.volume * 100);
        pipDoc.getElementById("pip-vol").value = val;
        $("#volume").value = val;
        localStorage.setItem("subcurrent-volume", val);
        pipDoc.getElementById("pip-mute").textContent = state.volume === 0 ? "\u{1F507}" : "\u{1F50A}";
    });

    // PiP target language picker
    pipDoc.getElementById("pip-target-lang").addEventListener("change", (e) => {
        state.targetLanguage = e.target.value;
        $("#target-lang").value = e.target.value;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: "config",
                target_language: e.target.value,
            }));
        }
    });

    pipWindow.addEventListener("pagehide", () => {
        pipWindow = null;
    });

    pipWindow.addEventListener("resize", () => fitPipText());

    // Immediately sync current subtitle state into PiP
    const mainSub = $("#subtitle-text");
    const mainTr = $("#translation-text");
    if (state.capturing && mainSub && !mainSub.classList.contains("inactive")) {
        const translation = mainTr ? mainTr.textContent : null;
        syncPipSubtitles(false, null, translation || null);
    } else if (state.capturing) {
        syncPipSubtitles(true, "Listening...");
    }

    // Sync connection dot
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        pipDoc.getElementById("pip-dot").classList.add("connected");
    }
}

function syncPipSubtitles(inactive, text, translation) {
    if (!pipWindow) return;
    const el = pipWindow.document.getElementById("pip-content");
    const trEl = pipWindow.document.getElementById("pip-translation");
    const subs = pipWindow.document.getElementById("pip-subs");
    if (!el || !trEl || !subs) return;
    if (inactive) {
        el.className = "inactive";
        el.style.fontSize = "";
        el.textContent = text || "Waiting for audio...";
        trEl.textContent = "";
        subs.classList.remove("translating");
    } else {
        el.className = "";
        el.innerHTML = $("#subtitle-text").innerHTML;
        if (translation) {
            if (state.translationHighlight) {
                trEl.innerHTML = translation.split(/\s+/).map(w =>
                    `<span class="tr-word">${w}</span>`
                ).join(" ");
            } else {
                trEl.textContent = translation;
            }
            subs.classList.add("translating");
        } else {
            trEl.innerHTML = "";
            subs.classList.remove("translating");
        }
        fitPipText();
    }
}

function fitPipText() {
    if (!pipWindow) return;
    const container = pipWindow.document.getElementById("pip-subs");
    const content = pipWindow.document.getElementById("pip-content");
    const trEl = pipWindow.document.getElementById("pip-translation");
    if (!container || !content || !content.textContent.trim()) return;

    const maxW = container.clientWidth - 16;
    const maxH = container.clientHeight - 12;
    if (maxW <= 0 || maxH <= 0) return;

    const hasTr = trEl && trEl.textContent;

    let lo = 12, hi = 160;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        content.style.fontSize = mid + "px";
        if (hasTr) trEl.style.fontSize = mid + "px";
        const contentH = content.scrollHeight + (hasTr ? trEl.scrollHeight + 8 : 0);
        const contentW = Math.max(content.scrollWidth, hasTr ? trEl.scrollWidth : 0);
        if (contentW > maxW || contentH > maxH) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    content.style.fontSize = lo + "px";
    if (hasTr) trEl.style.fontSize = lo + "px";
}

if ("documentPictureInPicture" in window) {
    $("#pip-toggle").style.display = "flex";
    $("#pip-toggle").addEventListener("click", openPiP);

    // Auto-open PiP when switching tabs, auto-close when returning
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && state.capturing && !pipWindow) {
            openPiP();
        } else if (!document.hidden && pipWindow) {
            pipWindow.close();
            pipWindow = null;
        }
    });
}

// When returning to tab, drop stale subtitles so we don't lag behind
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && subtitleQueue.length > 0) {
        // Keep only the most recent subtitle, drop the rest
        const latest = subtitleQueue[subtitleQueue.length - 1];
        subtitleQueue.length = 0;
        subtitleQueue.push(latest);
        if (!animationId && !showTimer) scheduleNext();
    }
});

// --- Mute toggle ---

let muted = false;
let preMuteVolume = 0.8;
$("#mute-toggle").addEventListener("click", () => {
    muted = !muted;
    if (muted) {
        preMuteVolume = state.volume;
        setVolume(0);
        $("#volume").value = 0;
    } else {
        setVolume(preMuteVolume);
        $("#volume").value = Math.round(preMuteVolume * 100);
    }
});

// --- Toolbar auto-dim ---

let dimTimer = null;
const TOOLBAR_DIM_DELAY = 5000;

function resetDimTimer() {
    const toolbar = $("#toolbar");
    toolbar.classList.remove("dimmed");
    if (dimTimer) clearTimeout(dimTimer);
    dimTimer = setTimeout(() => {
        if (state.capturing) {
            toolbar.classList.add("dimmed");
        }
    }, TOOLBAR_DIM_DELAY);
}

document.addEventListener("mousemove", resetDimTimer);
document.addEventListener("touchstart", resetDimTimer);
document.addEventListener("keydown", resetDimTimer);

// --- Enter screen ---

$("#enter-btn").addEventListener("click", async () => {
    // Create AudioContext on user gesture so browsers allow playback
    state.audioCtx = new AudioContext({ sampleRate: 48000 });
    if (navigator.audioSession) {
        navigator.audioSession.type = "playback";
    }
    await state.audioCtx.resume();

    $("#enter-screen").style.display = "none";
    $("#app").style.display = "flex";

    connect();
    requestWakeLock();
    loadOutputDevices();
});
