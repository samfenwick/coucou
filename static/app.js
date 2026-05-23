// Subcurrent — Web UI
// Full implementation in Task 8

const $ = (sel) => document.querySelector(sel);

const state = {
    ws: null,
    capturing: false,
    syncOffset: 0,
};

// --- Source list ---

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

// --- Sync offset ---

$("#sync-offset").addEventListener("input", (e) => {
    state.syncOffset = parseInt(e.target.value, 10);
    $("#sync-offset-label").textContent = `${state.syncOffset}ms`;
});

// --- Init ---

$("#refresh-sources").addEventListener("click", loadSources);
loadSources();
