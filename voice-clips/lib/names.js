// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Naming rules for the clips. They mirror what the app does when it LOOKS a clip up (tts_engine._search_dir_for_clip):
// the file name, without its extension, must equal the announced text, compared case-insensitively after strip().
// The same functions exist in the Python bench (voices_pipeline.py); a test compares both on awkward inputs.

export const SMALL_WORDS = new Set(["the", "of", "a", "an", "and", "in", "on", "to", "for", "at", "by"]);

/** (title, note) of a marker name: the exact twin of marker_engine.split_title_meta (and of splitSongName on the tablet page). What is written between braces in a song's name is the
 *  musician's NOTE ("Hallelujah {La mineur, capo 2}"), not part of the title. An odd name (unclosed, nested or lone brace, or a name made only of a note) is returned as it is. */
export function splitTitleMeta(name) {
  const raw = name == null ? "" : String(name);
  if (raw.indexOf("{") < 0 && raw.indexOf("}") < 0) return { title: raw, note: "" };
  let title = "";
  let depth = 0;
  let start = -1;
  const notes = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c === "{") {
      if (depth > 0) return { title: raw, note: "" };
      depth = 1;
      start = i;
    } else if (c === "}") {
      if (depth === 0) return { title: raw, note: "" };
      depth = 0;
      const note = raw.slice(start + 1, i).split(/\s+/).filter(Boolean).join(" ");
      if (note) notes.push(note);
    } else if (depth === 0) {
      title += c;
    }
  }
  if (depth !== 0) return { title: raw, note: "" };
  title = title.split(/\s+/).filter(Boolean).join(" ");
  if (!title) return { title: raw, note: "" };
  return { title, note: notes.join(" \u00b7 ") };
}

/** The file name the app looks for a SONG title: the title without its note, compared by the app as strip().lower() (inner spaces are NOT normalised when there is no note). */
export function titleKey(name) {
  return splitTitleMeta(name).title.trim();
}

/** Any other name (a section, a loop word, a typed name): exactly as written, ends trimmed. The app never strips braces from those. */
export function cleanKey(text) {
  return String(text).trim();
}

/** Text to speak. An ALL-CAPS name is put back in normal case (some engines spell capitals out). */
export function speakable(text) {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length && letters.every((c) => /\p{Lu}/u.test(c))) {
    return text
      .split(" ")
      .map((w, i) => (i === 0 || !SMALL_WORDS.has(w.toLowerCase()) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
      .join(" ");
  }
  return text;
}

// The app finds a clip by its EXACT name (nothing is guessed or approximated), so a name that can not be a file name on the user's system is never changed quietly: it is reported, and
// that row is kept out of the ZIP until it is renamed. macOS forbids "/" and ":" ("READY?.wav" is a valid name there); Windows forbids more, and a few reserved names.
export const FORBIDDEN = { mac: "/:", windows: '<>:"/\\|?*' };
export const SYSTEM_LABEL = { mac: "macOS", windows: "Windows" };
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i; // reserved even with an extension (CON.wav)

/** null when `key` can be a file name (without its extension) on `target`, else a sentence saying why not. */
export function fileNameProblem(key, target = "mac") {
  const k = String(key).trim();
  const system = SYSTEM_LABEL[target] || target;
  if (!k) return "The name is empty.";
  const bad = FORBIDDEN[target] || FORBIDDEN.mac;
  const found = [...new Set([...k].filter((c) => bad.includes(c)))];
  if (found.length) return `A file name cannot contain ${found.map((c) => `\u201c${c}\u201d`).join(" ")} on ${system}.`;
  if ([...k].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return `A file name cannot contain control characters on ${system}.`;
  if (target === "windows") {
    if (k.endsWith(".")) return "A file name cannot end with a period on Windows.";
    const stem = k.split(".")[0].trim();
    if (WINDOWS_RESERVED.test(stem)) return `\u201c${stem}\u201d is a name reserved by Windows.`;
  }
  if (new TextEncoder().encode(k).length > 200) return "This name is too long for a file name.";
  return null;
}

/** The file name (without extension) a name is saved under: exactly the name, ends trimmed. */
export function fileStem(key) {
  return String(key).trim();
}

/** The comparison key the app uses for file names. */
export function lookupKey(text) {
  return String(text).trim().toLowerCase();
}

export const LOOP_WORDS = [
  ["Loop", "en"],
  ["One more time", "en"],
  ["Last time", "en"],
];

/** One announcement to produce. */
export function makeEntry(key, spoken = null, lang = "en", kind = "free") {
  const k = kind === "title" ? titleKey(key) : cleanKey(key);
  return { key: k, spoken: spoken || speakable(k), lang, kind, covered: false };
}

/** « name | spoken text | language » per line (the last two fields are optional); a line starting with # is a comment. */
export function entriesFromTyped(text, defaultLang = "en") {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    out.push(makeEntry(parts[0], parts[1] || null, parts[2] || defaultLang, "free"));
  }
  return out.filter((e) => e.key);
}

/** Titles, then their sections, then the loop words; one entry per distinct (case-insensitive) name. */
export function entriesFromStructure(struct, { titleLang = "en", sectionLang = "en", withLoops = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = (e) => {
    const k = e.key.toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  };
  for (const song of struct.songs) {
    add(makeEntry(song.title, song.spoken || null, song.lang || titleLang, "title"));
    for (const name of song.sections || []) add(makeEntry(name, null, sectionLang, "section"));
  }
  if (withLoops) for (const [w, lang] of LOOP_WORDS) add(makeEntry(w, null, lang, "loop"));
  return out;
}

/** Marks the entries whose name already has a clip inside the app. */
export function markCovered(entries, shippedNames) {
  const have = new Set(shippedNames.map(lookupKey));
  for (const e of entries) e.covered = have.has(lookupKey(e.key));
  return entries;
}
