// Phrase alignment for the interlinear layout. The server translates each
// utterance as one string, so French and English are paired here by splitting
// both at punctuation and matching the pieces by length.
//
// French rows are decided from the French words alone, and only from words
// already seen, so a line streamed word by word keeps its rows when the final
// text and translation arrive.

(function (root) {
    const SENTENCE_END = /[.!?…]+["»”)]*$/;
    const CLAUSE_END = /[,;:]+["»”)]*$|^[—–-]$/;

    // A clause shorter than this stays on the row with what follows it, so
    // "Moi," or "Alors," don't get a row of their own.
    const MIN_ROW_CHARS = 14;
    // Longest run of pieces one side may merge to match a single piece on the other.
    const MAX_MERGE = 4;
    const MERGE_PENALTY = 0.35;
    // A pairing whose length ratio is further off than this (as a factor) is
    // treated as a misalignment and the whole group gets one translation.
    const SENTENCE_TOLERANCE = Math.log(2.4);
    const CLAUSE_TOLERANCE = Math.log(1.9);

    function tokens(text) {
        return (text || "").trim().split(/\s+/).filter(Boolean);
    }

    function charLen(toks, start, end) {
        let n = 0;
        for (let i = start; i < end; i++) n += toks[i].length + 1;
        return n;
    }

    // Split [start, end) of a token list into [s, e) runs ending where `boundary` matches.
    function segment(toks, start, end, boundary) {
        const segs = [];
        let s = start;
        for (let i = start; i < end; i++) {
            if (boundary.test(toks[i]) && i + 1 < end) {
                segs.push([s, i + 1]);
                s = i + 1;
            }
        }
        segs.push([s, end]);
        return segs;
    }

    function frenchRows(fr) {
        const rows = [];
        let s = 0;
        for (let i = 0; i < fr.length; i++) {
            const last = i + 1 === fr.length;
            const sentence = SENTENCE_END.test(fr[i]);
            const clause = CLAUSE_END.test(fr[i]) && charLen(fr, s, i + 1) >= MIN_ROW_CHARS;
            if (last || sentence || clause) {
                rows.push([s, i + 1]);
                s = i + 1;
            }
        }
        return rows;
    }

    // Length-based alignment of two segment lists (after Gale & Church). Returns
    // [[frStart, frEnd, enStart, enEnd], ...] or null when no pairing fits.
    function alignSegments(fr, frSegs, en, enSegs, ratio, tolerance) {
        const n = frSegs.length;
        const m = enSegs.length;
        const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
        const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
        cost[0][0] = 0;
        for (let i = 0; i <= n; i++) {
            for (let j = 0; j <= m; j++) {
                if (cost[i][j] === Infinity) continue;
                for (let a = 1; a <= MAX_MERGE && i + a <= n; a++) {
                    for (let b = 1; b <= MAX_MERGE && j + b <= m; b++) {
                        if (a > 1 && b > 1) continue;
                        const lf = charLen(fr, frSegs[i][0], frSegs[i + a - 1][1]);
                        const le = charLen(en, enSegs[j][0], enSegs[j + b - 1][1]);
                        const off = Math.abs(Math.log(le / (lf * ratio)));
                        if (off > tolerance) continue;
                        const c = cost[i][j] + off + MERGE_PENALTY * (a + b - 2);
                        if (c < cost[i + a][j + b]) {
                            cost[i + a][j + b] = c;
                            back[i + a][j + b] = [a, b];
                        }
                    }
                }
            }
        }
        if (cost[n][m] === Infinity) return null;
        const out = [];
        let i = n;
        let j = m;
        while (i > 0 || j > 0) {
            const [a, b] = back[i][j];
            out.unshift([frSegs[i - a][0], frSegs[i - 1][1], enSegs[j - b][0], enSegs[j - 1][1]]);
            i -= a;
            j -= b;
        }
        return out;
    }

    // Pair French words with English phrases.
    //   frWords: French word strings (punctuation attached, as transcribed)
    //   en: English translation, or empty while there is none yet
    // Returns [{ fr: [start, end], en, rows: [[start, end], ...] }], where the
    // ranges index into frWords and rows are how the French is broken into lines.
    function alignPhrases(frWords, en) {
        const fr = frWords.map((w) => (w == null ? "" : String(w)));
        if (fr.length === 0) return [];
        const rows = frenchRows(fr);
        const rowsIn = (s, e) => rows.filter(([rs, re]) => rs >= s && re <= e);
        const group = (s, e, text) => ({ fr: [s, e], en: text, rows: rowsIn(s, e) });

        const enToks = tokens(en);
        if (enToks.length === 0) return rows.map(([s, e]) => group(s, e, ""));

        const ratio = charLen(enToks, 0, enToks.length) / charLen(fr, 0, fr.length);
        const frSentences = segment(fr, 0, fr.length, SENTENCE_END);
        const sentences = alignSegments(
            fr, frSentences, enToks, segment(enToks, 0, enToks.length, SENTENCE_END),
            ratio, SENTENCE_TOLERANCE,
        );
        if (!sentences) return [group(0, fr.length, enToks.join(" "))];

        const groups = [];
        for (const [fs, fe, es, ee] of sentences) {
            const frRows = rowsIn(fs, fe);
            const enClauses = segment(enToks, es, ee, CLAUSE_END);
            const localRatio = charLen(enToks, es, ee) / charLen(fr, fs, fe);
            // Sentences the translation merged or split are kept whole, since
            // their clause boundaries no longer correspond.
            const merged = segment(fr, fs, fe, SENTENCE_END).length > 1
                || segment(enToks, es, ee, SENTENCE_END).length > 1;
            const clauses = !merged && (frRows.length > 1 || enClauses.length > 1)
                ? alignSegments(fr, frRows, enToks, enClauses, localRatio, CLAUSE_TOLERANCE)
                : null;
            for (const [cfs, cfe, ces, cee] of clauses || [[fs, fe, es, ee]]) {
                groups.push(group(cfs, cfe, enToks.slice(ces, cee).join(" ")));
            }
        }
        return groups;
    }

    const api = { alignPhrases };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.CoucouAlign = api;
})(typeof window !== "undefined" ? window : globalThis);
