// Coucou  - Web UI

const $ = (sel) => document.querySelector(sel);

// Declared early: apply*() helpers run during init and reference this before
// the Picture-in-Picture section executes.
let pipWindow = null;

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
    reconnectDelay: 300,
    // Audio-subtitle sync: maps stream time → AudioContext time
    streamTimeBase: null,   // stream_time of first audio chunk
    audioCtxTimeBase: null, // audioCtx.currentTime when that chunk was scheduled
    translateEnabled: false,
    translateActive: true,  // user toggle (persisted locally)
    wordHighlight: localStorage.getItem("subcurrent-word-highlight") !== "false", // on by default
    translationHighlight: localStorage.getItem("subcurrent-tr-highlight") === "true",
    showOriginal: localStorage.getItem("subcurrent-show-original") !== "false", // on by default
    layout: localStorage.getItem("coucou-layout") || "interlinear",
    // French on top with the smaller English under it: the top line gets read
    // first and longest, so this keeps the eye on the French.
    trPosition: localStorage.getItem("coucou-tr-position") === "above" ? "above" : "below",
    // Focus shows only the row being spoken; flow shows the scrolling column.
    ilView: localStorage.getItem("coucou-il-view") === "flow" ? "flow" : "focus",
    showPrevLine: localStorage.getItem("coucou-show-prev") === "true",
    showNextLines: localStorage.getItem("coucou-show-next") === "true",
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

// Each binary frame is a float64 LE stream time followed by int16 mono 48kHz PCM.
const AUDIO_HEADER_BYTES = 8;
// Lead kept between the audio clock and the next scheduled chunk, so late
// chunks (network or CPU jitter) don't underrun.
const PREROLL = 0.18;
// Audio arriving faster than it plays is a backlog (a tab coming back from the
// background, or a stalled connection draining). Beyond this lead it is dropped
// rather than queued, so playback stays at the live edge.
const MAX_LEAD = 1.0;
// Fade-in after a cold start or resync, long enough to avoid a click.
const FADE_IN = 0.25;

const liveSources = new Set();

function markSynced(streamTime, ctxTime) {
    const wasNull = state.streamTimeBase == null;
    state.streamTimeBase = streamTime;
    state.audioCtxTimeBase = ctxTime;
    // Sync just established: place any queued subtitles against the audio
    if (wasNull && subtitleQueue.length > 0) {
        for (const item of subtitleQueue) {
            item.showAt = item.data.start ? streamTimeToWallClock(item.data.start) : Date.now();
        }
        // Lines whose audio has already played become history, not a replay
        while (subtitleQueue.length > 0 && subtitleQueue[0].data.replay) {
            const { data } = subtitleQueue[0];
            if (streamTimeToWallClock(data.end ?? data.start ?? 0) > Date.now()) break;
            subtitleQueue.shift();
            if (ilEnabled()) ilAddHistory(data);
        }
        subtitleQueue.sort((a, b) => a.showAt - b.showAt);
        ilSyncUpcoming();
        if (!animationId && !showTimer) scheduleNext();
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
    state.gainNode.gain.value = 0;
    state.gainNode.connect(state.audioCtx.destination);
}

// Short ramps instead of jumps, so volume changes and mute don't click.
function rampGain(target, seconds) {
    const g = state.gainNode;
    if (!g) return;
    const now = state.audioCtx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(target, now + seconds);
}

function setVolume(vol) {
    state.volume = vol;
    rampGain(vol, 0.03);
}

// Fade out and drop everything scheduled, and forget the audio-to-stream
// mapping. The next chunk starts fresh at the live edge with a fade-in.
const FADE_OUT = 0.03;

function resetAudio() {
    if (state.gainNode) {
        rampGain(0, FADE_OUT);
        const stopAt = state.audioCtx.currentTime + FADE_OUT;
        for (const src of liveSources) {
            try { src.stop(stopAt); } catch (e) {}
        }
    }
    liveSources.clear();
    state.nextPlayTime = 0;
    state.streamTimeBase = null;
    state.audioCtxTimeBase = null;
}

function playAudioChunk(frame) {
    const ctx = state.audioCtx;
    if (!ctx || ctx.state === "closed" || frame.byteLength <= AUDIO_HEADER_BYTES) return;

    // A suspended or interrupted clock doesn't advance. Chunks scheduled against
    // it would pile up and all play at once when it restarts.
    if (ctx.state !== "running") {
        ctx.resume().catch(() => {});
        return;
    }

    ensureGainNode();

    try {
        const streamTime = new DataView(frame, 0, AUDIO_HEADER_BYTES).getFloat64(0, true);
        const int16 = new Int16Array(frame, AUDIO_HEADER_BYTES);
        const numSamples = int16.length;
        const now = ctx.currentTime;

        if (state.nextPlayTime > now + MAX_LEAD) return;

        const coldStart = state.nextPlayTime === 0;
        const underrun = !coldStart && state.nextPlayTime < now;
        if (coldStart || underrun) state.nextPlayTime = now + PREROLL;

        const audioBuffer = ctx.createBuffer(1, numSamples, 48000);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < numSamples; i++) {
            channel[i] = int16[i] / 32768;
        }
        // Soften the edge after an underrun gap (~5ms) so it doesn't crackle.
        if (underrun) {
            const fadeSamples = Math.min(240, numSamples);
            for (let i = 0; i < fadeSamples; i++) channel[i] *= i / fadeSamples;
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(state.gainNode);
        source.onended = () => liveSources.delete(source);
        liveSources.add(source);
        source.start(state.nextPlayTime);

        if (coldStart) {
            // Leaves any fade-out from resetAudio in place before this point
            const g = state.gainNode.gain;
            g.cancelScheduledValues(state.nextPlayTime);
            g.setValueAtTime(0, state.nextPlayTime);
            g.linearRampToValueAtTime(state.volume, state.nextPlayTime + FADE_IN);
        }
        markSynced(streamTime, state.nextPlayTime);
        state.nextPlayTime += audioBuffer.duration;
    } catch (err) {
        console.warn("Audio playback error:", err);
    }
}

// --- Subtitle Rendering (queue + word timers) ---

const subtitleQueue = [];
let animationId = null;
let showTimer = null;

function clearSubtitles() {
    subtitleQueue.length = 0;
    if (animationId) { clearTimeout(animationId); animationId = null; }
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    $("#subtitle-text").textContent = "";
    $("#translation-text").textContent = "";
    ilClear();
    seenSubtitles.clear();
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
    // Interlinear keeps the last lines on screen through a pause, dimmed.
    ilRoot().classList.add("idle");
    syncPipSubtitles(true, "");
}

function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    // Clear subtitle after 8s of no new content
    staleTimer = setTimeout(clearStaleSubtitle, 8000);
}

function showPartialSubtitle(text) {
    // Don't let a partial overwrite a recent final (which has translation).
    // Interlinear keeps that final on screen above the partial, so it needn't wait.
    const holdFinal = Date.now() - lastFinalTime < 2000;
    if (holdFinal && !ilEnabled()) return;
    // Cancel any in-progress final subtitle animation
    if (animationId) { clearTimeout(animationId); animationId = null; }
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    // Flush any stale queued subtitles  - partial represents current state
    for (const { data } of subtitleQueue) {
        if (data.ilBuilt && data.ilBuilt.unit.classList.contains("il-next")) ilSetPast(data.ilBuilt.unit);
    }
    subtitleQueue.length = 0;
    if (ilEnabled()) ilShowPartial(text);
    resetStaleTimer();
    if (holdFinal) return;
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

// Lines already received on this screen. The server replays recent lines on
// every connect, and after a network blip those are already showing.
const seenSubtitles = new Set();

function enqueueSubtitle(data) {
    const key = `${data.start}|${data.text}|${data.translation}`;
    if (seenSubtitles.has(key)) return;
    seenSubtitles.add(key);
    if (seenSubtitles.size > 100) seenSubtitles.delete(seenSubtitles.values().next().value);

    if (state.streamTimeBase == null) {
        if (state.audioBroadcast && data.start != null) {
            // Sync not established yet (just connected mid-stream). Defer until
            // the first audio chunk, which recomputes showAt for queued items.
            subtitleQueue.push({ data, showAt: Infinity });
            return;
        }
        // No audio sync (subtitles-only mode)  - show immediately
        presentSubtitle(data);
        return;
    }

    // Sync to audio playback: show subtitle when its audio actually plays
    const now = Date.now();
    if (data.replay && streamTimeToWallClock(data.end ?? data.start ?? 0) < now) {
        // Sent on connect, and its audio played before this tab joined
        if (ilEnabled()) ilAddHistory(data);
        return;
    }
    const showAt = data.start ? streamTimeToWallClock(data.start) : now;
    // scheduleNext skips past-due entries except the newest, so a backlog
    // catches up to the audio instead of replaying.
    subtitleQueue.push({ data, showAt });
    subtitleQueue.sort((a, b) => a.showAt - b.showAt);
    ilSyncUpcoming();

    // Kick off processing if idle
    if (!animationId && !showTimer) scheduleNext();
}

function scheduleNext() {
    if (subtitleQueue.length === 0) {
        animationId = null;
        showTimer = null;
        return;
    }

    // Skip stale entries  - only show the most recent past-due one
    const now = Date.now();
    while (subtitleQueue.length > 1 && subtitleQueue[1].showAt <= now) {
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

// --- Interlinear layout ---

// Past utterances kept for scrolling back through.
const IL_KEEP = 80;
// After the reader scrolls away from the live line, go back to it once the
// screen has been left alone this long.
const IL_RESUME_MS = 4000;
const il = {
    current: null,   // utterance being spoken
    partial: false,  // current is a partial still being streamed
    focus: null,     // row being spoken, held in the middle of the screen
    was: null,       // row spoken just before it
    browsing: false, // reader has scrolled away from the live line
    touching: false,
    resumeTimer: null,
    followTarget: NaN,
};

function ilEnabled() {
    return state.layout === "interlinear";
}

function ilRoot() {
    return $("#interlinear");
}

// Build one utterance as phrase pairs. Returns the unit element plus the French
// word spans (in transcript order) and, for translation highlighting, the
// English word spans and which of them each French word maps to.
function ilBuildUnit(frWords, speakers, translation) {
    const unit = document.createElement("div");
    unit.className = "il-unit";
    const wordEls = [];
    const trWordEls = [];
    const trMap = [];
    const multiSpeaker = new Set(speakers.filter((s) => s != null)).size >= 2;

    for (const group of CoucouAlign.alignPhrases(frWords, translation || "")) {
        const [s, e] = group.fr;
        const pairEl = document.createElement("div");
        pairEl.className = "il-pair";
        if (multiSpeaker) pairEl.classList.add("il-spk", `speaker-${(speakers[s] ?? 0) % 5}`);

        // Every French row gets an English slot so rows keep their place while
        // the translation is pending. The English goes in the group's last slot,
        // which CSS moves to the top when the translation is shown above.
        let enEl = null;
        for (const [rs, re] of group.rows) {
            const frEl = document.createElement("div");
            frEl.className = "il-fr";
            for (let i = rs; i < re; i++) {
                const w = document.createElement("span");
                w.className = "word";
                w.textContent = i < re - 1 ? `${frWords[i]} ` : frWords[i];
                frEl.appendChild(w);
                wordEls.push(w);
            }
            enEl = document.createElement("div");
            enEl.className = "il-en";
            pairEl.append(frEl, enEl);
        }
        enEl.classList.add("il-en-main");

        const enWords = group.en ? group.en.split(/\s+/) : [];
        if (state.translationHighlight && enWords.length) {
            const offset = trWordEls.length;
            enWords.forEach((t, k) => {
                const span = document.createElement("span");
                span.className = "tr-word";
                span.textContent = k < enWords.length - 1 ? `${t} ` : t;
                enEl.appendChild(span);
                trWordEls.push(span);
            });
            for (let i = s; i < e; i++) {
                const progress = (i - s + 1) / (e - s);
                trMap[i] = offset + Math.min(enWords.length - 1, Math.floor(progress * enWords.length));
            }
        } else {
            enEl.textContent = group.en;
        }
        unit.appendChild(pairEl);
    }
    return { unit, wordEls, trWordEls, trMap };
}

// Word spans must stay index-aligned with data.words for karaoke highlighting.
function ilBuildFromData(data) {
    const hasWords = data.words && data.words.length > 0;
    const frWords = hasWords
        ? data.words.map((w) => String(w.word).trim())
        : (data.text || "").trim().split(/\s+/).filter(Boolean);
    if (!frWords.length) return null;
    const speakers = hasWords ? data.words.map((w) => w.speaker) : [];
    return ilBuildUnit(frWords, speakers, state.translateActive ? data.translation : "");
}

function ilSetPast(unit) {
    unit.classList.remove("il-current", "il-next", "il-whole");
    unit.classList.add("il-past");
    for (const p of unit.querySelectorAll(".il-now")) p.classList.remove("il-now");
}

// Make an utterance the one being spoken. `timed` means it has word timings,
// so the focus can follow the speech row by row.
function ilShow(built, partial, timed) {
    const track = $("#il-track");
    const unit = built.unit;
    if (il.current && il.partial) {
        // A final replaces the partial it completes, in place and with the
        // same alignment, so no word moves.
        unit.style.animation = "none";
        unit.classList.add("il-stream");
        il.current.replaceWith(unit);
    } else {
        for (const u of track.querySelectorAll(".il-prev")) u.classList.remove("il-prev");
        if (il.current) {
            ilSetPast(il.current);
            // While the next sentence is being streamed, the one before it is
            // the newest English on screen, so it stays readable.
            if (partial) il.current.classList.add("il-prev");
        }
        if (!unit.isConnected) track.insertBefore(unit, track.querySelector(".il-next"));
    }
    // Anything queued ahead of this line was skipped to catch up with the audio.
    for (let p = unit.previousElementSibling; p && p.classList.contains("il-next"); p = p.previousElementSibling) {
        ilSetPast(p);
    }
    unit.classList.remove("il-next", "il-past");
    unit.classList.add("il-current");
    if (partial) unit.classList.add("il-stream");
    unit.classList.toggle("il-whole", !timed);
    il.current = unit;
    il.partial = partial;

    const root = ilRoot();
    root.classList.toggle("live", partial);
    root.classList.remove("idle");
    $("#app").classList.add("il-has-content");
    ilPrune();

    const pairs = unit.querySelectorAll(".il-pair");
    if (timed) ilSetFocus(pairs[0]);
    else if (unit.classList.contains("il-stream")) ilSetFocus(pairs[pairs.length - 1]);
    else ilSetFocus(unit);
}

function ilSetFocus(el) {
    if (il.focus === el) return;
    if (il.focus) il.focus.classList.remove("il-now");
    il.focus = el || null;
    if (el && el.classList.contains("il-pair")) el.classList.add("il-now");
    // The row just before the focus, which focus view can show faintly above it.
    // Found by position because a streamed line is rebuilt on every update.
    if (il.was) il.was.classList.remove("il-was");
    il.was = null;
    if (el) {
        const unit = el.classList.contains("il-pair") ? el.parentElement : el;
        let prev = el.classList.contains("il-pair") ? el.previousElementSibling : null;
        if (!prev && unit.previousElementSibling) {
            const pairs = unit.previousElementSibling.querySelectorAll(".il-pair");
            prev = pairs[pairs.length - 1] || null;
        }
        if (prev) {
            prev.classList.add("il-was");
            il.was = prev;
        }
    }
    ilFollow();
}

// Scroll offset that puts the focused row in the middle of the screen.
function ilFocusTop(scroller) {
    let el = il.focus && il.focus.isConnected ? il.focus : null;
    if (!el) {
        const past = scroller.querySelectorAll(".il-past");
        el = past[past.length - 1];
    }
    if (!el) return null;
    const view = scroller.clientHeight;
    const r = el.getBoundingClientRect();
    const top = r.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    let h = r.height;
    if (el.closest(".il-stream")) {
        // A streamed row grows downwards when it wraps. Place it by a fixed
        // one-line height so the wrap does not scroll the screen.
        const css = getComputedStyle(document.documentElement);
        h = parseFloat(css.getPropertyValue("--subtitle-size")) * 1.2
            + parseFloat(css.getPropertyValue("--translation-size")) * 1.4;
    }
    if (h > view * 0.7) return top - view * 0.15;
    return top + h / 2 - view / 2;
}

// Focus view jumps straight to the new row and fades it in; flow view scrolls.
// Pass "auto" to jump or "smooth" to scroll regardless of the view.
function ilFollow(how) {
    if (il.browsing) return;
    const instant = how === "auto" || (how == null && state.ilView === "focus");
    const scroller = $("#il-scroll");
    const top = ilFocusTop(scroller);
    if (top == null) return;
    const target = Math.round(Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight)));
    if (how == null && Math.abs(target - il.followTarget) < 1) return;
    il.followTarget = target;
    scroller.scrollTo({ top: target, behavior: instant ? "auto" : "smooth" });
}

// Drop the oldest history, keeping what is on screen where it is.
function ilPrune() {
    if (il.browsing) return;
    const scroller = $("#il-scroll");
    const track = $("#il-track");
    let past = track.querySelectorAll(".il-past").length;
    let shift = 0;
    while (past > IL_KEEP && track.firstElementChild.classList.contains("il-past")) {
        const first = track.firstElementChild;
        const next = first.nextElementSibling;
        shift += next ? next.offsetTop - first.offsetTop : first.offsetHeight;
        first.remove();
        past--;
    }
    if (shift) {
        scroller.scrollTop -= shift;
        il.followTarget = NaN;
    }
}

// Lines that arrived ahead of their audio go below the current one, dimmed,
// in the order they will be spoken.
function ilSyncUpcoming() {
    if (!ilEnabled() || il.partial) return;
    const track = $("#il-track");
    let before = null;
    for (let i = subtitleQueue.length - 1; i >= 0; i--) {
        const { data, showAt } = subtitleQueue[i];
        const existing = data.ilBuilt && data.ilBuilt.unit.isConnected ? data.ilBuilt.unit : null;
        if (existing) {
            if (existing.classList.contains("il-next")) before = existing;
            continue;
        }
        if (!Number.isFinite(showAt)) continue;
        const built = ilBuildFromData(data);
        if (!built) continue;
        built.unit.classList.add("il-next");
        data.ilBuilt = built;
        track.insertBefore(built.unit, before);
        before = built.unit;
        $("#app").classList.add("il-has-content");
    }
}

// Add an utterance straight to history, for lines that played before this tab
// connected.
function ilAddHistory(data) {
    const built = ilBuildFromData(data);
    if (!built) return;
    const track = $("#il-track");
    if (il.current) {
        // Keep history in order: anything already on screen is older.
        ilSetPast(il.current);
        il.current = null;
        il.partial = false;
    }
    built.unit.classList.add("il-past");
    track.insertBefore(built.unit, track.querySelector(".il-next"));
    $("#app").classList.add("il-has-content");
    ilPrune();
    // Until the next line plays, the newest of these is the one on show.
    const pairs = built.unit.querySelectorAll(".il-pair");
    ilSetFocus(pairs[pairs.length - 1]);
}

function ilShowPartial(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    ilShow(ilBuildUnit(words, [], ""), true, false);
}

function ilPresent(data) {
    let built = data.ilBuilt;
    if (!built || !built.unit.classList.contains("il-next") || !built.unit.isConnected) {
        built = ilBuildFromData(data);
    }
    if (!built) return null;
    data.ilBuilt = built;
    ilShow(built, false, !!(data.words && data.words.length));
    return built;
}

function ilClear() {
    $("#il-track").replaceChildren();
    il.current = null;
    il.partial = false;
    il.focus = null;
    il.was = null;
    il.followTarget = NaN;
    ilStopBrowsing();
    ilRoot().classList.remove("live", "idle");
    $("#app").classList.remove("il-has-content");
}

// --- Scrolling back through history ---

function ilBrowse() {
    if (!il.browsing) {
        il.browsing = true;
        ilRoot().classList.add("browsing");
        $("#il-live").hidden = false;
    }
    ilArmResume();
}

function ilArmResume() {
    clearTimeout(il.resumeTimer);
    if (!il.touching) il.resumeTimer = setTimeout(ilResume, IL_RESUME_MS);
}

function ilStopBrowsing() {
    clearTimeout(il.resumeTimer);
    il.browsing = false;
    ilRoot().classList.remove("browsing");
    $("#il-live").hidden = true;
}

function ilResume() {
    ilStopBrowsing();
    il.followTarget = NaN;
    ilPrune();
    ilFollow("smooth");
}

{
    const scroller = $("#il-scroll");
    const endTouch = () => {
        il.touching = false;
        if (il.browsing) ilArmResume();
    };
    // Only a drag or a wheel counts as scrolling back. A tap does not.
    scroller.addEventListener("touchstart", () => {
        il.touching = true;
        clearTimeout(il.resumeTimer);
    }, { passive: true });
    scroller.addEventListener("touchmove", ilBrowse, { passive: true });
    scroller.addEventListener("touchend", endTouch);
    scroller.addEventListener("touchcancel", endTouch);
    scroller.addEventListener("wheel", ilBrowse, { passive: true });
    // Momentum keeps scrolling after the finger lifts; wait for it to settle.
    scroller.addEventListener("scroll", () => { if (il.browsing) ilArmResume(); }, { passive: true });
    $("#il-live").addEventListener("click", ilResume);
}

function ilApplyDisplayFlags() {
    const root = ilRoot();
    root.classList.toggle("mono", !(state.translateEnabled && state.translateActive));
    root.classList.toggle("no-fr", !state.showOriginal && state.translateEnabled && state.translateActive);
    $("#app").classList.toggle("tr-above", state.trPosition === "above");
    root.classList.toggle("focus", state.ilView === "focus");
    root.classList.toggle("show-prev", state.showPrevLine);
    root.classList.toggle("show-next", state.showNextLines);
}

function applyLayout(layout) {
    state.layout = layout === "stacked" ? "stacked" : "interlinear";
    const app = $("#app");
    app.classList.toggle("layout-interlinear", state.layout === "interlinear");
    app.classList.toggle("layout-stacked", state.layout === "stacked");
    $("#layout-select").value = state.layout;
    if (state.layout !== "interlinear") ilClear();
}

window.addEventListener("resize", () => {
    il.followTarget = NaN;
    ilFollow("auto");
});

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
    state.shownSubtitle = data;
    // Cancel any in-progress animation (e.g. provisional being replaced by final)
    if (animationId) { clearTimeout(animationId); animationId = null; }
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

    const ilBuilt = ilEnabled() ? ilPresent(data) : null;

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
    const ilWordEls = ilBuilt ? ilBuilt.wordEls : [];
    const ilTrEls = ilBuilt ? ilBuilt.trWordEls : [];
    const ilTrMap = ilBuilt ? ilBuilt.trMap : [];
    let prevIlTrIdx = -1;
    // PiP word refs are resolved lazily inside step() so a PiP window opened
    // mid-line picks up live highlighting instead of stalling until the next subtitle.
    let pipWordEls = pipWindow ? pipWindow.document.querySelectorAll("#pip-content .word") : [];
    // Translation word elements for proportional highlighting
    const trWordEls = state.translationHighlight ? $("#translation-text").querySelectorAll(".tr-word") : [];
    let pipTrWordEls = state.translationHighlight && pipWindow ? pipWindow.document.querySelectorAll("#pip-translation .tr-word") : [];
    const firstStart = data.words[0].start;
    const lastEnd = data.words[data.words.length - 1].end;
    const totalMs = (lastEnd - firstStart) * 1000;
    let prevIdx = -1;
    let prevTrIdx = -1;
    // Time highlighting from the audio clock when synced, so a line shown late
    // (after catching up) highlights the word actually being heard.
    const startWall = state.streamTimeBase != null ? streamTimeToWallClock(firstStart) : Date.now();

    function step() {
        const elapsed = Date.now() - startWall;

        // PiP may have opened after this animation started; bind to its word
        // elements once they exist so highlighting continues without a stall.
        if (pipWindow && pipWordEls.length === 0 && wordEls.length > 0) {
            pipWordEls = pipWindow.document.querySelectorAll("#pip-content .word");
            if (state.translationHighlight) {
                pipTrWordEls = pipWindow.document.querySelectorAll("#pip-translation .tr-word");
            }
        }

        for (let i = prevIdx + 1; i < data.words.length; i++) {
            const wordStart = (data.words[i].start - firstStart) * 1000;
            if (elapsed >= wordStart) {
                // Original word highlighting (blue)
                if (state.wordHighlight) {
                    if (prevIdx >= 0) {
                        wordEls[prevIdx].classList.remove("active");
                        if (pipWordEls[prevIdx]) pipWordEls[prevIdx].classList.remove("active");
                        if (ilWordEls[prevIdx]) ilWordEls[prevIdx].classList.remove("active");
                    }
                    wordEls[i].classList.add("active");
                    if (pipWordEls[i]) pipWordEls[i].classList.add("active");
                    if (ilWordEls[i]) ilWordEls[i].classList.add("active");
                }
                prevIdx = i;

                // Interlinear: highlight within the English of the same phrase
                const ilTrIdx = ilTrMap[i] ?? -1;
                if (ilTrIdx !== prevIlTrIdx) {
                    if (prevIlTrIdx >= 0) ilTrEls[prevIlTrIdx].classList.remove("active");
                    if (ilTrIdx >= 0) ilTrEls[ilTrIdx].classList.add("active");
                    prevIlTrIdx = ilTrIdx;
                }

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
        // Keep the row being spoken in the middle of the screen
        if (ilBuilt && ilBuilt.unit === il.current && ilWordEls[prevIdx]) {
            ilSetFocus(ilWordEls[prevIdx].closest(".il-pair"));
        }

        if (elapsed < totalMs) {
            // Wake only at the next word boundary. A per-frame loop would run
            // 120 times a second on a ProMotion iPad for a few changes a second.
            const next = prevIdx + 1 < data.words.length
                ? (data.words[prevIdx + 1].start - firstStart) * 1000
                : totalMs;
            animationId = setTimeout(step, Math.max(0, next - elapsed));
        } else {
            if (state.wordHighlight && prevIdx >= 0) {
                wordEls[prevIdx].classList.remove("active");
                if (pipWordEls[prevIdx]) pipWordEls[prevIdx].classList.remove("active");
                if (ilWordEls[prevIdx]) ilWordEls[prevIdx].classList.remove("active");
            }
            if (prevIlTrIdx >= 0) ilTrEls[prevIlTrIdx].classList.remove("active");
            if (prevTrIdx >= 0 && trWordEls[prevTrIdx]) {
                trWordEls[prevTrIdx].classList.remove("active");
                if (pipTrWordEls[prevTrIdx]) pipTrWordEls[prevTrIdx].classList.remove("active");
            }
            animationId = null;
            scheduleNext();
        }
    }

    animationId = setTimeout(step, 0);
}

// --- WebSocket ---

// A gap this long between messages while audio is streaming means the page was
// frozen (iOS does this to background tabs) and the socket has a backlog behind it.
const FREEZE_GAP_MS = 2000;
let lastMessageAt = 0;
let lastResyncAt = 0;

// When the iPad moves to another Wi-Fi access point the socket can die without
// a close event and stay open for minutes. The server answers every ping, so a
// ping left unanswered this long means the connection is gone.
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 4000;
// Safari can wait a minute or more on a connection attempt whose packets were
// lost mid-roam.
const CONNECT_TIMEOUT_MS = 3000;
const RECONNECT_MAX_MS = 2000;
let connectStartedAt = 0;
let unansweredPingSince = 0;

function connect() {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    const old = state.ws;
    state.ws = null;
    if (old && old.readyState <= WebSocket.OPEN) {
        try { old.close(); } catch (e) {}
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}`);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    lastMessageAt = 0;
    connectStartedAt = performance.now();
    unansweredPingSince = 0;

    ws.addEventListener("open", () => {
        if (ws !== state.ws) return;
        $("#connection-status").textContent = "Connected";
        $("#connection-status").classList.add("connected");
        state.reconnectDelay = 300;
    });

    ws.addEventListener("message", (event) => {
        // Messages still queued on a socket we replaced are stale
        if (ws !== state.ws) return;
        const now = performance.now();
        const gap = lastMessageAt ? now - lastMessageAt : 0;
        lastMessageAt = now;
        unansweredPingSince = 0;
        if (gap > FREEZE_GAP_MS && state.capturing && state.audioBroadcast) {
            resync();
            return;
        }

        if (event.data instanceof ArrayBuffer) {
            playAudioChunk(event.data);
            return;
        }
        const data = JSON.parse(event.data);
        if (data.type === "subtitle") {
            state.lastSubtitle = data;
            enqueueSubtitle(data);
        } else if (data.type === "partial") {
            showPartialSubtitle(data.text);
        } else if (data.type === "status") {
            handleStatus(data);
        } else if (data.type === "settings") {
            applyServerSettings(data);
        } else if (data.type === "sync_reset") {
            // Settings changed  - reset sync state so subtitles recalibrate
            resetAudio();
            clearSubtitles();
        }
    });

    ws.addEventListener("close", () => {
        if (ws !== state.ws) return;
        $("#connection-status").textContent = "Disconnected";
        $("#connection-status").classList.remove("connected");
        state.capturing = false;
        scheduleReconnect();
    });

    ws.addEventListener("error", () => ws.close());
}

function scheduleReconnect() {
    if (state.reconnectTimer) return;
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
    state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connect();
    }, delay);
}

// Drop the connection and everything buffered behind it, and start again from
// the live edge. The server replays recent lines on connect, and the ones whose
// audio has already played come back as history.
function resync() {
    const now = performance.now();
    if (now - lastResyncAt < 1000) return;
    lastResyncAt = now;
    resetAudio();
    clearSubtitles();
    state.reconnectDelay = 300;
    connect();
}

// Back on the network, or back in view with a dead socket: reconnect now
// instead of waiting out the backoff.
function reconnectIfDown() {
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
        state.reconnectDelay = 300;
        connect();
    }
}
window.addEventListener("online", () => { if (state.reconnectTimer || state.ws) reconnectIfDown(); });

// Skipped while hidden: timers there are frozen or throttled, and the
// visibility handler checks the connection on the way back.
function checkConnection() {
    const ws = state.ws;
    if (!ws || document.hidden) return;
    const now = performance.now();
    if (ws.readyState === WebSocket.CONNECTING) {
        if (now - connectStartedAt > CONNECT_TIMEOUT_MS) connect();
        return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (unansweredPingSince && now - unansweredPingSince > PING_TIMEOUT_MS) {
        $("#connection-status").textContent = "Disconnected";
        $("#connection-status").classList.remove("connected");
        state.capturing = false;
        lastResyncAt = 0;
        resync();
        return;
    }
    if (!unansweredPingSince) unansweredPingSince = now;
    try { ws.send('{"type":"ping"}'); } catch (e) {}
}
setInterval(checkConnection, PING_INTERVAL_MS);


function handleStatus(data) {
    const bs = $("#broadcast-status");
    if (data.status === "capturing") {
        state.capturing = true;
        state.audioBroadcast = data.broadcast_audio !== false;
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
        state.audioBroadcast = data.broadcast_audio !== false;
        // Reset sync state for clean restart
        resetAudio();
        clearSubtitles();
        if (data.broadcast_audio === false) {
            // No audio to buffer  - show "Listening..." immediately
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
        state.audioBroadcast = false;
        $("#subtitle-text").textContent = "Waiting for audio...";
        $("#subtitle-text").classList.add("inactive");
        bs.textContent = "Not Broadcasting";
        bs.className = "";
        syncPipSubtitles(true, "Waiting for audio...");
        clearSubtitles();
        resetAudio();
        // Suspend once the fade-out has played, to stop the audio thread
        // while nothing is broadcasting.
        setTimeout(() => {
            if (!state.capturing && state.audioCtx && state.audioCtx.state === "running") {
                state.audioCtx.suspend();
            }
        }, 100);
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
        // User previously picked a specific device  - respect that choice
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

    // No saved preference  - auto-route to the server's original output device
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
    fitPipText();
}

$("#font-size").addEventListener("input", (e) => {
    applyFontSize(e.target.value);
    localStorage.setItem("subcurrent-font-size", e.target.value);
});

function applyTranslationSize(size) {
    document.documentElement.style.setProperty("--translation-size", `${size}px`);
    $("#translation-font-size").value = size;
    $("#translation-font-size-label").textContent = `${size}px`;
    fitPipText();
}

$("#translation-font-size").addEventListener("input", (e) => {
    applyTranslationSize(e.target.value);
    localStorage.setItem("subcurrent-translation-size", e.target.value);
});

// Colour theme (per-client, saved locally)
function applyTheme(name) {
    document.documentElement.dataset.theme = name;
    document.querySelectorAll(".theme-swatch").forEach(btn =>
        btn.classList.toggle("active", btn.dataset.theme === name)
    );
    syncPipTheme();
}

$("#theme-swatches").addEventListener("click", (e) => {
    const btn = e.target.closest(".theme-swatch");
    if (!btn) return;
    applyTheme(btn.dataset.theme);
    localStorage.setItem("subcurrent-theme", btn.dataset.theme);
});

// Show original toggle
const trPositionEl = $("#tr-position-select");
trPositionEl.value = state.trPosition;
trPositionEl.addEventListener("change", (e) => {
    state.trPosition = e.target.value === "above" ? "above" : "below";
    localStorage.setItem("coucou-tr-position", state.trPosition);
    ilApplyDisplayFlags();
    il.followTarget = NaN;
    ilFollow("auto");
});

const ilViewEl = $("#il-view-select");
ilViewEl.value = state.ilView;
ilViewEl.addEventListener("change", (e) => {
    state.ilView = e.target.value === "flow" ? "flow" : "focus";
    localStorage.setItem("coucou-il-view", state.ilView);
    ilApplyDisplayFlags();
    il.followTarget = NaN;
    ilFollow("auto");
});

for (const [id, key, prop] of [
    ["#show-prev-toggle", "coucou-show-prev", "showPrevLine"],
    ["#show-next-toggle", "coucou-show-next", "showNextLines"],
]) {
    const el = $(id);
    el.checked = state[prop];
    el.addEventListener("change", (e) => {
        state[prop] = e.target.checked;
        localStorage.setItem(key, e.target.checked ? "true" : "false");
        ilApplyDisplayFlags();
    });
}

const showOriginalEl = $("#show-original-toggle");
showOriginalEl.checked = state.showOriginal;
showOriginalEl.addEventListener("change", (e) => {
    state.showOriginal = e.target.checked;
    localStorage.setItem("subcurrent-show-original", e.target.checked ? "true" : "false");
    ilApplyDisplayFlags();
});

$("#layout-select").addEventListener("change", (e) => {
    applyLayout(e.target.value);
    localStorage.setItem("coucou-layout", state.layout);
    // Redraw the line on screen in the chosen layout
    if (state.lastSubtitle && ilEnabled()) ilPresent(state.lastSubtitle);
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
const savedTranslationSize = localStorage.getItem("subcurrent-translation-size");
if (savedTranslationSize) applyTranslationSize(savedTranslationSize);
applyTheme(localStorage.getItem("subcurrent-theme") || "amber-ice");
applyLayout(state.layout);
ilApplyDisplayFlags();
const savedVolume = localStorage.getItem("subcurrent-volume");
if (savedVolume) applyVolume(savedVolume);
const savedTranslate = localStorage.getItem("coucou-translate-active");
if (savedTranslate !== null) state.translateActive = savedTranslate === "1";
// Set a default source flag until first detection
$("#translate-toggle").textContent = "\u{1F30D}";

// Translate toggle  - click the flag bar to toggle translations on/off
function updateTranslateBarUI() {
    ilApplyDisplayFlags();
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

// --- Keep the screen on ---

// The Screen Wake Lock API only exists in a secure context, so it is missing when
// the viewer is opened over plain http on the LAN. iOS doesn't auto-lock while
// a video is playing, so a tiny muted looping video stands in for it there.
const KEEP_AWAKE_VIDEO = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAVoy4PEyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApQAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAACiQAAAAsAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAApxtZGF0AAACcgYF//9u3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOi0zOi0zIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0yLjAwOjAuNzAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS00IHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4yMACAAAAAD2WIhAXzn///D0UAAVefgAAAAAdBmjgL5zqA";
let wakeLock = null;
let keepAwakeVideo = null;

async function keepScreenOn() {
    if (document.hidden) return;
    if ("wakeLock" in navigator) {
        if (wakeLock && !wakeLock.released) return;
        try {
            wakeLock = await navigator.wakeLock.request("screen");
            return;
        } catch (err) {
            console.warn("Wake lock failed, falling back to video:", err);
        }
    }
    if (!keepAwakeVideo) {
        keepAwakeVideo = document.createElement("video");
        keepAwakeVideo.src = KEEP_AWAKE_VIDEO;
        keepAwakeVideo.muted = true;
        keepAwakeVideo.loop = true;
        keepAwakeVideo.playsInline = true;
        keepAwakeVideo.setAttribute("playsinline", "");
        keepAwakeVideo.setAttribute("aria-hidden", "true");
        keepAwakeVideo.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(keepAwakeVideo);
    }
    keepAwakeVideo.play().catch((err) => console.warn("Keep-awake video failed:", err));
}

// The browser drops the wake lock whenever the page is hidden; take it again.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && $("#enter-screen").style.display === "none") keepScreenOn();
});

// --- Picture-in-Picture ---

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
            background: #0a0a0a; color: var(--original-color, #e8e8e8);
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
        /* Lines differentiated by the selected theme's colour pair */
        #pip-subs.translating #pip-content {
            color: var(--original-color, #e8e8e8);
        }
        #pip-translation {
            line-height: 1.3; margin-top: 0.3rem;
            text-align: center; width: 100%; color: var(--translation-color, #aabbcc);
        }
        #pip-translation:empty { display: none; }
        .tr-word { display: inline; transition: color 0.15s ease, text-shadow 0.15s ease; }
        .tr-word.active { color: var(--translation-active, #ffaa44); text-shadow: 0 0 12px var(--translation-active, #ffaa44); }
        .word { display: inline; transition: color 0.15s ease, text-shadow 0.15s ease; }
        .word.active { color: var(--original-active, #4a9eff); text-shadow: 0 0 12px var(--original-active, #4a9eff); }
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
    syncPipTheme();

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

// Copy the active theme's colour vars into the PiP document (CSS custom
// properties don't cascade across separate documents).
function syncPipTheme() {
    if (!pipWindow) return;
    const cs = getComputedStyle(document.documentElement);
    const root = pipWindow.document.documentElement;
    ["--original-color", "--original-active", "--translation-color", "--translation-active"].forEach(v => {
        root.style.setProperty(v, cs.getPropertyValue(v).trim());
    });
}

// Ratio of translation size to original size, so PiP honours the slider pair.
function trSizeRatio() {
    const cs = getComputedStyle(document.documentElement);
    const o = parseFloat(cs.getPropertyValue("--subtitle-size")) || 56;
    const t = parseFloat(cs.getPropertyValue("--translation-size")) || 36;
    return t / o;
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
    const ratio = trSizeRatio();

    let lo = 12, hi = 160;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        content.style.fontSize = mid + "px";
        if (hasTr) trEl.style.fontSize = Math.round(mid * ratio) + "px";
        const contentH = content.scrollHeight + (hasTr ? trEl.scrollHeight + 8 : 0);
        const contentW = Math.max(content.scrollWidth, hasTr ? trEl.scrollWidth : 0);
        if (contentW > maxW || contentH > maxH) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    content.style.fontSize = lo + "px";
    if (hasTr) trEl.style.fontSize = Math.round(lo * ratio) + "px";
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

// When returning to the tab, catch up to what is playing now. Timers in a
// frozen tab leave the karaoke timer stuck, and the render queue stalls until
// the next message.
document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;

    // Resume audio if the browser suspended or interrupted it while backgrounded.
    if (state.audioCtx && state.audioCtx.state !== "running" && state.audioCtx.state !== "closed") {
        state.audioCtx.resume().catch(() => {});
    }

    if (state.reconnectTimer) reconnectIfDown();
    // Pings were not sent while hidden, so start the timeout afresh.
    unansweredPingSince = 0;
    checkConnection();

    // Messages stopped while hidden: the page was frozen and the socket is
    // holding a backlog of stale audio. Start again from live instead.
    const stalled = lastMessageAt > 0 && performance.now() - lastMessageAt > FREEZE_GAP_MS;
    if (state.capturing && state.audioBroadcast && stalled) {
        resync();
        return;
    }

    // Tear down any frozen animation/timer so the render loop can restart.
    if (animationId) { clearTimeout(animationId); animationId = null; }
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }

    // Show the newest line that is already due. Later ones stay queued for
    // their audio.
    const now = Date.now();
    let due = null;
    while (subtitleQueue.length > 0 && subtitleQueue[0].showAt <= now) due = subtitleQueue.shift().data;
    if (!due && subtitleQueue.length === 0) due = state.lastSubtitle;
    if (due && due !== state.shownSubtitle) presentSubtitle(due);
    else scheduleNext();
});

// Restored from the back-forward cache with a dead socket and stale schedule.
window.addEventListener("pageshow", (e) => {
    if (e.persisted && state.ws) resync();
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
    keepScreenOn();
    loadOutputDevices();
});
