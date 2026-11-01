// Run with: node --test tests/test_align.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { alignPhrases } = createRequire(import.meta.url)("../static/align.js");

function pairs(fr, en) {
    const words = fr.split(/\s+/);
    return alignPhrases(words, en).map((p) => [words.slice(p.fr[0], p.fr[1]).join(" "), p.en]);
}

const aligned = [
    {
        name: "one sentence, no clauses",
        fr: "Restez avec nous.",
        en: "Stay with us.",
        want: [["Restez avec nous.", "Stay with us."]],
    },
    {
        name: "two sentences pair one to one",
        fr: "Vous avez vu la neige ce matin ? Moi, je ne m'y attendais pas du tout.",
        en: "Did you see the snow this morning? I wasn't expecting it at all.",
        want: [
            ["Vous avez vu la neige ce matin ?", "Did you see the snow this morning?"],
            ["Moi, je ne m'y attendais pas du tout.", "I wasn't expecting it at all."],
        ],
    },
    {
        name: "matching clauses split within a sentence",
        fr: "Le match d'hier soir était incroyable, avec trois buts dans les dix dernières minutes.",
        en: "Last night's match was incredible, with three goals in the last ten minutes.",
        want: [
            ["Le match d'hier soir était incroyable,", "Last night's match was incredible,"],
            ["avec trois buts dans les dix dernières minutes.", "with three goals in the last ten minutes."],
        ],
    },
    {
        name: "comma only on the French side merges the clauses",
        fr: "Moi, je ne m'y attendais pas du tout.",
        en: "I wasn't expecting it at all.",
        want: [["Moi, je ne m'y attendais pas du tout.", "I wasn't expecting it at all."]],
    },
    {
        name: "translation merged two sentences into one",
        fr: "Il fait froid. Très froid.",
        en: "It's very, very cold.",
        want: [["Il fait froid. Très froid.", "It's very, very cold."]],
    },
    {
        name: "chunk cut mid-sentence keeps the trailing fragment",
        fr: "Restez avec nous. Le match d'hier soir était",
        en: "Stay with us. Last night's match was",
        want: [
            ["Restez avec nous.", "Stay with us."],
            ["Le match d'hier soir était", "Last night's match was"],
        ],
    },
];

const fallback = [
    {
        name: "wildly different lengths fall back to one pair",
        fr: "Oui. Bon, alors on commence tout de suite avec les informations de ce matin.",
        en: "Yes, well, so we start. Right away. With the news. From this morning.",
        want: [["Oui. Bon, alors on commence tout de suite avec les informations de ce matin.",
            "Yes, well, so we start. Right away. With the news. From this morning."]],
    },
];

const noTranslation = [
    {
        name: "partial text is split at clauses with empty English",
        fr: "Bonjour à tous, et bienvenue",
        en: "",
        want: [["Bonjour à tous,", ""], ["et bienvenue", ""]],
    },
    {
        name: "a short opening clause keeps its row",
        fr: "Aujourd'hui, on va parler",
        en: "",
        want: [["Aujourd'hui, on va parler", ""]],
    },
    {
        name: "missing translation",
        fr: "Bonjour à tous",
        en: null,
        want: [["Bonjour à tous", ""]],
    },
];

for (const [group, cases] of [["aligned", aligned], ["fallback", fallback], ["no translation", noTranslation]]) {
    for (const c of cases) {
        test(`${group}: ${c.name}`, () => {
            assert.deepEqual(pairs(c.fr, c.en), c.want);
        });
    }
}

test("every French word lands in exactly one pair, in order", () => {
    const fr = "Bonjour à tous, et bienvenue. Aujourd'hui, on parle de la météo ; il fait froid !";
    const en = "Hello everyone, and welcome. Today, we talk about the weather; it's cold!";
    const words = fr.split(/\s+/);
    const out = alignPhrases(words, en);
    assert.equal(out[0].fr[0], 0);
    for (let i = 1; i < out.length; i++) assert.equal(out[i].fr[0], out[i - 1].fr[1]);
    assert.equal(out.at(-1).fr[1], words.length);
    assert.equal(out.map((p) => p.en).join(" "), en);
});

const streamed = [
    "Bonjour à tous, et bienvenue dans notre émission du matin.",
    "Moi, je ne m'y attendais pas du tout. Les routes sont glissantes, alors faites bien attention en voiture.",
    "Le match d'hier soir était incroyable, avec trois buts dans les dix dernières minutes.",
];

for (const text of streamed) {
    test(`rows of a streamed prefix survive the final text: ${text.slice(0, 30)}`, () => {
        const words = text.split(/\s+/);
        const finalRows = alignPhrases(words, "").flatMap((g) => g.rows);
        for (let n = 1; n < words.length; n++) {
            const rows = alignPhrases(words.slice(0, n), "").flatMap((g) => g.rows);
            // Every completed row of the prefix is a row of the final text.
            for (const row of rows.slice(0, -1)) assert.ok(finalRows.some((r) => r[0] === row[0] && r[1] === row[1]), `prefix ${n}: ${row}`);
        }
    });
}

test("a translation spanning two French rows keeps both rows", () => {
    const words = "Les routes sont glissantes, alors faites attention.".split(/\s+/);
    const [g] = alignPhrases(words, "The roads are slippery so be careful.");
    assert.deepEqual(g.fr, [0, words.length]);
    assert.deepEqual(g.rows, [[0, 4], [4, 7]]);
});

test("empty input", () => {
    assert.deepEqual(alignPhrases([], "Hello"), []);
});
