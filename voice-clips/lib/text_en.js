// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// English text -> phonemes for Kokoro. The normalisation and the phoneme clean-ups are a readable port of what kokoro-js does
// (kokoro-js 1.2.x, Apache-2.0, https://github.com/hexgrad/kokoro/tree/main/kokoro.js), so the voice sees the same input as in the reference
// implementation. Only the English path exists here (the normalisation below is English); lib/espeak.js can already phonemize French, Spanish and Portuguese.

function normalizeTime(match) {
  if (match.includes(".")) return match;
  if (match.includes(":")) {
    const [h, m] = match.split(":").map(Number);
    return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function normalizeMoney(match) {
  const unit = match[0] === "$" ? "dollar" : "pound";
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${unit}s`;
  if (!match.includes(".")) return `${match.slice(1)} ${unit}${match.slice(1) === "1" ? "" : "s"}`;
  const [whole, frac] = match.slice(1).split(".");
  const cents = parseInt(frac.padEnd(2, "0"), 10);
  const sub = match[0] === "$" ? (cents === 1 ? "cent" : "cents") : cents === 1 ? "penny" : "pence";
  return `${whole} ${unit}${whole === "1" ? "" : "s"} and ${cents} ${sub}`;
}

function normalizeDecimal(match) {
  const [whole, frac] = match.split(".");
  return `${whole} point ${frac.split("").join(" ")}`;
}

/** Text clean-up before phonemisation (quotes, abbreviations, numbers, money...). */
export function normalizeEnglish(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, '"')
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ")
    .replace(/  +/, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, normalizeTime)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, normalizeMoney)
    .replace(/\d*\.\d+/g, normalizeDecimal)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`, "g");

/** Splits into runs of words (to phonemise) and runs of punctuation (kept as they are). */
export function splitKeepPunctuation(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT_RE)) {
    if (last < m.index) parts.push({ match: false, text: text.slice(last, m.index) });
    if (m[0].length > 0) parts.push({ match: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ match: false, text: text.slice(last) });
  return parts;
}

/** Fixes applied to eSpeak's output so that it fits Kokoro's alphabet (american = en-us voices, "a" prefix). */
export function fixPhonemes(ipa, american = true) {
  let s = ipa
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (american) {
    s = s.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  }
  return s.trim();
}

/** text -> Kokoro phoneme string. `phonemize(text, lang)` is lib/espeak.js's function (injected, so this file also runs in Node tests). */
export async function phonemizeEnglish(text, phonemize, { american = true, normalize = true } = {}) {
  const clean = normalize ? normalizeEnglish(text) : text;
  const lang = american ? "en-us" : "en";
  let out = "";
  for (const part of splitKeepPunctuation(clean)) {
    out += part.match ? part.text : (await phonemize(part.text, lang)).join(" ");
  }
  return fixPhonemes(out, american);
}
