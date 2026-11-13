// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
import { readAls, AlsError } from "./lib/als.js";
import { entriesFromStructure, entriesFromTyped, markCovered, fileNameProblem, fileStem, speakable, lookupKey } from "./lib/names.js";
import { finalizeClip, encodeWav } from "./lib/wav.js";
import { makeZip } from "./lib/zip.js";
import { VoiceEngine } from "./lib/engine.js";

// ---------------------------------------------------------------- configuration (prototype: one English voice)
// The voice model (92 MB) is not part of this folder: by default it is read from models/ next to this page. A site that keeps it in its own storage sets window.VOICE_MODEL_BASE in config.js
// (an address ending in a slash; the server must allow this page to read it, CORS).
const MODEL_ROOT = new URL(window.VOICE_MODEL_BASE || "models/onnx-community/Kokoro-82M-v1.0-ONNX/", document.baseURI);
const ENGINE_CONFIG = {
  modelUrl: new URL("onnx/model_quantized.onnx", MODEL_ROOT).href,
  manifestUrl: new URL("model.json", MODEL_ROOT).href,
  vocabUrl: new URL("tokenizer.json", MODEL_ROOT).href,
  voicesBase: new URL("voices/", MODEL_ROOT).href,
  defaultVoice: "af_heart",
  modelSha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478", // the page refuses a model file that does not match this fingerprint
};
const VOICES = { en: "af_heart" }; // language -> voice. The other languages need a phonemizer the prototype does not have.
const KIND_LABEL = { title: "Title", section: "Section", loop: "Loop word", free: "Typed" };

// Announcements are short by design: a clip may last MAX_CLIP_SECONDS at most (measured on the clip as it is exported, silence at both ends already cut). A longer one is refused, never
// cut: a name chopped in the middle is worse than no clip. MAX_TEXT_CHARS is far more than two seconds of speech: such a text is refused without even computing it.
const MAX_CLIP_SECONDS = 2;
const MAX_TEXT_CHARS = 100;

// ---------------------------------------------------------------- state
const state = {
  entries: [], // the rows shown, in order
  removed: [], // rows the user removed (the "Restore" button brings them back)
  shipped: [],
  system: /Win/i.test(navigator.platform || "") ? "windows" : "mac",
  source: null, // what was read from the last .als: { name, size, modified, meta, warnings }
  engine: null,
  ready: null,
  readyInfo: null,
  busy: false,
  cancel: false,
  playing: null,
  nextId: 1,
  nextOrder: 1,
};

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), typed: $("typed"), typedAdd: $("typedAdd"), clear: $("clear"),
  engineBar: $("engineBar"), engineStatus: $("engineStatus"),
  detected: $("detected"), detectedSource: $("detectedSource"), detectedCounts: $("detectedCounts"), detectedWarnings: $("detectedWarnings"), detectedError: $("detectedError"),
  summary: $("summary"), rows: $("rows"), empty: $("empty"),
  genMissing: $("genMissing"), genAll: $("genAll"), stop: $("stop"), restore: $("restore"), genProgress: $("genProgress"), log: $("log"),
  system: $("system"), download: $("download"), downloadInfo: $("downloadInfo"),
};
els.system.value = state.system;

function log(line) {
  els.log.textContent += (els.log.textContent ? "\n" : "") + line;
  els.log.scrollTop = els.log.scrollHeight;
}

// ---------------------------------------------------------------- rows
function supported(e) {
  return Object.hasOwn(VOICES, e.lang);
}

function prepare(entry, source) {
  entry.id = state.nextId++;
  entry.order = state.nextOrder++;
  entry.source = source; // "als" (detected) | "typed"
  entry.detectedKey = entry.key; // the name as it was found: used to recognise the same row when the set is dropped again
  entry.spokenEdited = false;
  entry.clip = null;
  entry.status = "idle";
  entry.error = null;
  entry.longSeconds = 0; // the length of a clip that was refused for lasting too long
  return entry;
}

function releaseClip(e) {
  if (e.clip && e.clip.url) URL.revokeObjectURL(e.clip.url);
  e.clip = null;
}

/** Why this row can not be exported as it is, or null. Only the name matters: a clip with a name that can not be a file name is never renamed quietly. */
function problemOf(e) {
  const message = fileNameProblem(e.key, state.system);
  if (message) return message;
  const key = lookupKey(e.key);
  if (state.entries.some((x) => x !== e && lookupKey(x.key) === key)) return "Another row has the same name (the app finds one clip per name, and a file name is not case sensitive).";
  return null;
}

/** Why the spoken text of this row can not be turned into an announcement, or null. */
function textProblemOf(e) {
  const text = e.spoken.trim();
  if (!text) return "There is nothing to say: type the spoken text.";
  if (text.length > MAX_TEXT_CHARS) return `This text is too long for an announcement (limit: ${MAX_CLIP_SECONDS} seconds, so ${MAX_TEXT_CHARS} characters at most). Shorten it.`;
  return null;
}

function refreshFlags() {
  markCovered(state.entries, state.shipped);
  for (const e of state.entries) {
    e.problem = problemOf(e);
    e.textProblem = textProblemOf(e);
  }
}

/** A row that can be created and exported. A row whose clip was refused for lasting too long waits for its text to be edited. */
function usable(e) {
  return supported(e) && !e.problem && !e.textProblem && e.status !== "long";
}

function addTypedEntries(list) {
  const have = new Set(state.entries.map((e) => lookupKey(e.key)));
  let added = 0;
  for (const raw of list) {
    const k = lookupKey(raw.key);
    if (!k || have.has(k)) continue;
    have.add(k);
    state.entries.push(prepare(raw, "typed"));
    added++;
  }
  refreshAll();
  return added;
}

/** A new detection replaces the detected rows but keeps what the user did: a name already there keeps its clip and its edits, a name the user removed stays removed, typed rows stay. */
function applyDetection(fresh) {
  const existing = new Map();
  for (const e of state.entries) if (e.source === "als") existing.set(lookupKey(e.detectedKey), e);
  const removedKeys = new Set(state.removed.filter((e) => e.source === "als").map((e) => lookupKey(e.detectedKey)));
  const freshKeys = new Set(fresh.map((f) => lookupKey(f.key)));
  const next = [];
  let added = 0;
  let dropped = 0;
  for (const f of fresh) {
    const k = lookupKey(f.key);
    if (existing.has(k)) {
      next.push(existing.get(k));
      existing.delete(k);
    } else if (!removedKeys.has(k)) {
      next.push(prepare(f, "als"));
      added++;
    }
  }
  for (const gone of existing.values()) {
    releaseClip(gone);
    dropped++;
  }
  state.removed = state.removed.filter((e) => e.source !== "als" || freshKeys.has(lookupKey(e.detectedKey)));
  state.entries = [...next, ...state.entries.filter((e) => e.source !== "als")];
  return { added, dropped };
}

function removeEntry(e) {
  if (state.playing && state.playing.id === e.id) stopPlaying();
  releaseClip(e);
  e.status = "idle";
  state.entries = state.entries.filter((x) => x !== e);
  state.removed.push(e);
  refreshAll();
}

function restoreRemoved() {
  for (const e of state.removed) state.entries.push(e);
  state.removed = [];
  state.entries.sort((a, b) => a.order - b.order);
  refreshAll();
}

function clearList() {
  stopPlaying();
  for (const e of [...state.entries, ...state.removed]) releaseClip(e);
  state.entries = [];
  state.removed = [];
  state.source = null;
  els.log.textContent = "";
  els.genProgress.textContent = "";
  showError("");
  refreshAll();
}

// ---------------------------------------------------------------- reading a set
function formatSaved(ms) {
  const date = new Date(ms);
  const text = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const days = Math.floor((Date.now() - ms) / 86400000);
  const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `${text} (${ago})`;
}

function showError(message) {
  els.detectedError.textContent = message;
  els.detectedError.hidden = !message;
}

async function loadFile(file) {
  showError("");
  els.genProgress.textContent = "";
  try {
    const t0 = performance.now();
    const struct = await readAls(file);
    const ms = Math.round(performance.now() - t0);
    const { added, dropped } = applyDetection(markCovered(entriesFromStructure(struct), state.shipped));
    state.source = { name: file.name, size: file.size, modified: file.lastModified, meta: struct.meta, warnings: struct.warnings, songs: struct.songs, xmlBytes: struct.xmlBytes };
    refreshAll();
    log(`Read "${file.name}" in ${ms} ms (${(struct.xmlBytes / 1e6).toFixed(1)} MB of XML): ${struct.meta.songs} songs, ${struct.meta.sectionTrack ? struct.meta.sectionTrack.attached : 0} section blocks; ${added} row(s) added, ${dropped} dropped.`);
  } catch (err) {
    const message = err instanceof AlsError ? err.message : `Could not read “${file.name}”: ${err && err.message ? err.message : err}`;
    showError(message);
    log(`Could not read "${file.name}": ${message}`);
  }
}

function addTyped() {
  const list = entriesFromTyped(els.typed.value);
  const added = addTypedEntries(list);
  log(`Typed names: ${list.length} line(s), ${added} added.`);
  if (added) els.typed.value = "";
}

// ---------------------------------------------------------------- the detection panel
const WARNING_TEXT = {
  no_locators: () => "No locators found. MarkerList needs a locator at the start of each song: add them in Live, save the set and drop the file again.",
  no_end_marker: () => "No locator named END_LIVE. MarkerList needs one at the end of the show to start.",
  no_section_track: () => "No track named SECTION: only the song titles (and the loop words) are proposed. Type your section names on the left if you need them.",
  clips_outside_arrangement: (w) => `${w.count} clip${w.count > 1 ? "s" : ""} on the SECTION track ${w.count > 1 ? "are" : "is"} not in the main arrangement (session view or take lanes). MarkerList does not see ${w.count > 1 ? "them" : "it"}, so ${w.count > 1 ? "they were" : "it was"} ignored.`,
  blocks_outside_range: (w) => `${w.before + w.after} section block${w.before + w.after > 1 ? "s" : ""} ${w.before + w.after > 1 ? "are" : "is"} before the first song or after END_LIVE: ${w.before + w.after > 1 ? "they belong" : "it belongs"} to no song and ${w.before + w.after > 1 ? "were" : "was"} ignored.`,
  blank_section_names: (w) => `${w.count} section block${w.count > 1 ? "s have" : " has"} no name and ${w.count > 1 ? "were" : "was"} ignored.`,
};

function renderDetected() {
  const src = state.source;
  els.detected.hidden = !src;
  if (!src) return;
  const detected = state.entries.filter((e) => e.source === "als");
  const all = [...detected, ...state.removed.filter((e) => e.source === "als")];
  const covered = all.filter((e) => e.covered).length;
  const blocks = src.meta.sectionTrack ? src.meta.sectionTrack.attached : 0;
  const live = src.meta.creator ? src.meta.creator.replace(/^Ableton\s+/i, "") : "";
  els.detectedSource.textContent = `“${src.name}” · saved ${formatSaved(src.modified)}${live ? ` · ${live}` : ""} · ${Math.round(src.size / 1024)} KB`;
  els.detectedCounts.textContent = `${src.meta.songs} song${src.meta.songs === 1 ? "" : "s"} and ${blocks} section block${blocks === 1 ? "" : "s"} found, which makes ${all.length} different name${all.length === 1 ? "" : "s"} (the 3 loop words included): ${covered} already in the app.`;
  els.detectedWarnings.replaceChildren(
    ...src.warnings.map((w) => {
      const li = document.createElement("li");
      li.textContent = (WARNING_TEXT[w.code] || (() => w.code))(w);
      return li;
    }),
  );
  els.detectedWarnings.hidden = !src.warnings.length;
}

// ---------------------------------------------------------------- rendering of the list
function badgeOf(e) {
  if (e.status === "working") return ["work", "Creating…", ""];
  if (e.status === "queued") return ["work", "Waiting…", ""];
  if (e.status === "error") return ["bad", e.error || "Error", ""];
  if (e.status === "long") return ["bad", `Over ${MAX_CLIP_SECONDS} s`, e.error || ""];
  if (e.problem) return ["bad", "Fix the name", e.problem];
  if (e.textProblem) return ["bad", "Fix the text", e.textProblem];
  if (e.clip) return ["done", "Ready", ""];
  if (!supported(e)) return ["na", `No ${e.lang.toUpperCase()} voice yet`, ""];
  if (e.covered) return ["have", "Already in the app", "The app already speaks this name; create a clip only to replace it."];
  return ["todo", "To create", ""];
}

function updateRow(e) {
  const tr = els.rows.querySelector(`tr[data-id="${e.id}"]`);
  if (!tr) return;
  const [cls, text, hint] = badgeOf(e);
  const badge = tr.querySelector(".badge");
  badge.className = `badge ${cls}`;
  badge.textContent = text;
  if (hint) badge.title = hint;
  else badge.removeAttribute("title");
  tr.querySelector(".len").textContent = e.clip ? `${e.clip.dur.toFixed(2)} s` : e.status === "long" ? `${e.longSeconds.toFixed(2)} s` : "";
  const play = tr.querySelector("button.listen");
  play.disabled = !e.clip;
  play.textContent = state.playing && state.playing.id === e.id ? "■" : "▶";
  play.setAttribute("aria-label", `${state.playing && state.playing.id === e.id ? "Stop" : "Play"} ${e.key}`);
  const nameInput = tr.querySelector("input.fname");
  nameInput.classList.toggle("problem", !!e.problem);
  nameInput.title = e.problem || "The name of the file (without .wav): the app looks for a clip with exactly this name.";
  nameInput.setAttribute("aria-invalid", e.problem ? "true" : "false");
  const spokenInput = tr.querySelector("input.spoken");
  if (document.activeElement !== spokenInput) spokenInput.value = e.spoken;
  tr.querySelector("button.rm").setAttribute("aria-label", `Remove ${e.key}`);
}

function makeRow(e) {
  const tr = document.createElement("tr");
  tr.dataset.id = String(e.id);
  const cell = (cls, child) => {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    if (child) td.append(child);
    return td;
  };
  const kind = document.createElement("span");
  kind.textContent = KIND_LABEL[e.kind] || e.kind;

  const name = document.createElement("input");
  name.type = "text";
  name.className = "fname";
  name.value = e.key;
  name.spellcheck = false;
  name.setAttribute("aria-label", `File name for ${e.detectedKey}`);
  name.addEventListener("input", () => {
    const before = e.spoken;
    e.key = name.value.trim();
    if (!e.spokenEdited) e.spoken = speakable(e.key);
    if (e.spoken !== before) {
      if (state.playing && state.playing.id === e.id) stopPlaying();
      releaseClip(e);
      e.status = "idle";
    }
    refreshFlags();
    for (const x of state.entries) updateRow(x);
    updateControls();
    renderDetected();
  });
  name.addEventListener("change", () => {
    if (!e.key) {
      e.key = e.detectedKey;
      name.value = e.key;
      if (!e.spokenEdited) e.spoken = speakable(e.key);
      refreshFlags();
      for (const x of state.entries) updateRow(x);
      updateControls();
    }
  });
  name.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") name.blur();
  });

  const spoken = document.createElement("input");
  spoken.type = "text";
  spoken.className = "spoken";
  spoken.value = e.spoken;
  spoken.setAttribute("aria-label", `Spoken text for ${e.detectedKey}`);
  spoken.addEventListener("input", () => {
    e.spoken = spoken.value;
    e.spokenEdited = spoken.value !== speakable(e.key);
    if (e.clip) {
      if (state.playing && state.playing.id === e.id) stopPlaying();
      releaseClip(e);
      e.status = "idle";
    }
    if (e.status === "long" || e.status === "error") e.status = "idle"; // a new text deserves a new try
    e.textProblem = textProblemOf(e);
    updateRow(e);
    updateControls();
  });

  const badge = document.createElement("span");
  badge.className = "badge";
  const len = document.createElement("span");
  len.className = "len";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "listen"; // not "play": the Markerlist site has a .play class of its own (the big round button on its videos)
  play.addEventListener("click", () => togglePlay(e));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "rm";
  remove.textContent = "✕";
  remove.addEventListener("click", () => removeEntry(e));
  tr.append(cell("kind", kind), cell("", name), cell("", spoken), cell("", badge), cell("num", len), cell("act", play), cell("act", remove));
  return tr;
}

function renderAll() {
  els.rows.replaceChildren();
  for (const e of state.entries) {
    els.rows.append(makeRow(e));
    updateRow(e);
  }
  els.empty.hidden = state.entries.length > 0;
}

function refreshAll() {
  refreshFlags();
  renderAll();
  renderDetected();
  updateControls();
}

function updateControls() {
  const todo = state.entries.filter((e) => usable(e) && !e.clip && !e.covered);
  const any = state.entries.filter((e) => usable(e) && !e.clip);
  const clips = state.entries.filter((e) => e.clip);
  const exportable = clips.filter((e) => !e.problem);
  els.stop.hidden = !state.busy;
  els.genMissing.disabled = state.busy || todo.length === 0;
  els.genAll.disabled = state.busy || any.length === 0;
  els.download.disabled = state.busy || exportable.length === 0;
  els.restore.hidden = state.removed.length === 0;
  els.restore.textContent = `Restore ${state.removed.length} removed row${state.removed.length === 1 ? "" : "s"}`;
  els.genMissing.textContent = todo.length > 1 ? `Create the ${todo.length} missing clips` : todo.length === 1 ? "Create the missing clip" : "Create the missing clips";
  const skipped = clips.length - exportable.length;
  els.downloadInfo.textContent = exportable.length
    ? `${exportable.length} clip${exportable.length > 1 ? "s" : ""} in the ZIP${skipped ? `; ${skipped} left out: fix ${skipped > 1 ? "their names" : "its name"}` : ""}`
    : skipped ? `${skipped} clip${skipped > 1 ? "s" : ""} left out: fix ${skipped > 1 ? "their names" : "its name"}` : "";
  const total = state.entries.length;
  if (!total) {
    els.summary.textContent = state.removed.length ? "All rows were removed." : "No names yet.";
  } else {
    const covered = state.entries.filter((e) => e.covered && !e.problem).length;
    const bad = state.entries.filter((e) => e.problem).length;
    const na = state.entries.filter((e) => !supported(e)).length;
    const create = state.entries.filter((e) => usable(e) && !e.covered && !e.clip).length;
    const over = state.entries.filter((e) => e.status === "long").length;
    const badText = state.entries.filter((e) => e.textProblem).length;
    const removed = state.removed.length;
    els.summary.textContent =
      `${total} distinct name${total > 1 ? "s" : ""}${removed ? ` (${removed} removed)` : ""}: ${covered} already in the app, ${create} to create` +
      (bad ? `, ${bad} to rename` : "") +
      (over ? `, ${over} over ${MAX_CLIP_SECONDS} s` : "") +
      (badText ? `, ${badText} with a spoken text to fix` : "") +
      (na ? `, ${na} in a language this prototype cannot speak yet` : "") +
      (clips.length ? `. ${clips.length} clip${clips.length > 1 ? "s" : ""} ready.` : ".");
  }
}

// ---------------------------------------------------------------- playback
function stopPlaying() {
  if (state.playing) {
    const prev = state.playing;
    prev.audio.pause();
    state.playing = null;
    const e = state.entries.find((x) => x.id === prev.id);
    if (e) updateRow(e);
  }
}

function togglePlay(e) {
  if (state.playing && state.playing.id === e.id) return stopPlaying();
  stopPlaying();
  if (!e.clip) return;
  const audio = new Audio(e.clip.url);
  state.playing = { id: e.id, audio };
  audio.addEventListener("ended", () => {
    if (state.playing && state.playing.audio === audio) {
      state.playing = null;
      updateRow(e);
    }
  });
  audio.play().catch((err) => log(`Playback refused by the browser: ${err.message}`));
  updateRow(e);
}

// ---------------------------------------------------------------- voice engine
function mb(n) {
  return (n / 1e6).toFixed(0);
}

async function ensureEngine(overrides = {}) {
  if (state.ready) return state.ready;
  state.engine = new VoiceEngine(new URL("tts.worker.js", import.meta.url));
  state.engine.onProgress = (loaded, total) => {
    els.engineBar.style.width = total ? `${Math.min(100, (100 * loaded) / total).toFixed(1)}%` : "50%";
    els.engineStatus.textContent = total ? `Downloading the voice… ${mb(loaded)} of ${mb(total)} MB` : `Downloading the voice… ${mb(loaded)} MB`;
  };
  const threads = Number(new URLSearchParams(location.search).get("threads")) || undefined;
  els.engineStatus.textContent = "Starting the voice engine…";
  const engine = state.engine;
  state.ready = engine.load({ ...ENGINE_CONFIG, threads, ...overrides }).then((info) => {
    state.readyInfo = info;
    els.engineBar.style.width = "100%";
    els.engineStatus.textContent = `Ready (${info.fromCache ? "from the browser's cache" : "downloaded"}, checked, ${info.threads} thread${info.threads > 1 ? "s" : ""}).`;
    log(`Voice engine ready in ${(info.ms.total / 1000).toFixed(1)} s: model ${info.fromCache ? "read from cache" : "downloaded"} in ${(info.ms.modelFetch / 1000).toFixed(1)} s, session built in ${(info.ms.sessionCreate / 1000).toFixed(1)} s; ${info.threads} thread(s), cross-origin isolated: ${info.crossOriginIsolated}.`);
    return info;
  });
  state.ready.catch((err) => {
    state.ready = null;
    engine.terminate();
    els.engineBar.style.width = "0";
    els.engineStatus.textContent = `The voice engine could not start: ${err.message}`;
    log(`Voice engine failed: ${err.message} (model address: ${ENGINE_CONFIG.modelUrl})`);
  });
  return state.ready;
}

async function generate(entries) {
  if (state.busy || !entries.length) return;
  state.busy = true;
  state.cancel = false;
  for (const e of entries) {
    e.status = "queued";
    e.error = null;
    updateRow(e);
  }
  updateControls();
  const t0 = performance.now();
  let made = 0;
  let tooLong = 0;
  try {
    await ensureEngine();
    for (const [i, e] of entries.entries()) {
      if (state.cancel) {
        for (const rest of entries.slice(i)) {
          rest.status = "idle";
          updateRow(rest);
        }
        break;
      }
      if (!state.entries.includes(e)) continue; // removed while waiting
      els.genProgress.textContent = `Creating ${i + 1} of ${entries.length}: ${e.key}`;
      e.status = "working";
      updateRow(e);
      const spokenAtStart = e.spoken;
      try {
        const r = await state.engine.speak(spokenAtStart, VOICES[e.lang]);
        if (!state.entries.includes(e) || e.spoken !== spokenAtStart) {
          e.status = "idle"; // removed or edited while the clip was being created: the clip no longer matches the row
          updateRow(e);
          continue;
        }
        const y = finalizeClip(r.samples, r.sampleRate);
        const seconds = y.length / r.sampleRate;
        if (seconds > MAX_CLIP_SECONDS) {
          // refused, not cut; nothing is kept (no clip to listen to or to export)
          e.status = "long";
          e.longSeconds = seconds;
          e.error = `This clip lasts ${seconds.toFixed(1)} s and announcements are limited to ${MAX_CLIP_SECONDS} s. Shorten the spoken text.`;
          tooLong++;
          log(`${e.key.padEnd(18)} ${seconds.toFixed(2)} s   refused: over the ${MAX_CLIP_SECONDS} s limit`);
          updateRow(e);
          continue;
        }
        const wav = encodeWav(y, r.sampleRate);
        e.clip = { wav, sampleRate: r.sampleRate, dur: y.length / r.sampleRate, url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })), phonemes: r.phonemes, tokens: r.tokens, ms: r.ms, samples: y };
        e.status = "done";
        made++;
        log(`${e.key.padEnd(18)} ${e.clip.dur.toFixed(2)} s   phonemes ${String(r.tokens).padStart(3)}   ${r.ms.total} ms (${r.ms.phonemize} + ${r.ms.inference})${r.dropped ? `   ${r.dropped} unknown symbol(s) dropped` : ""}${r.truncated ? "   TRUNCATED" : ""}`);
      } catch (err) {
        e.status = "error";
        e.error = String(err.message || err).slice(0, 80);
        log(`${e.key}: ${err.message || err}`);
      }
      updateRow(e);
    }
    els.genProgress.textContent =
      `${made} clip${made === 1 ? "" : "s"} created in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
      (tooLong ? `; ${tooLong} refused for lasting more than ${MAX_CLIP_SECONDS} s` : "") +
      (state.cancel ? " (stopped)" : "") +
      ".";
  } catch (err) {
    for (const e of entries) if (e.status === "queued" || e.status === "working") e.status = "idle";
    els.genProgress.textContent = `Stopped: ${err.message || err}`;
    log(`Stopped: ${err.message || err}`);
    renderAll();
  } finally {
    state.busy = false;
    updateControls();
  }
}

// ---------------------------------------------------------------- ZIP
/** The ZIP holds the clips whose name can be a file name on the chosen system, each saved under EXACTLY its name; the others are listed in `skipped`, never renamed. */
function buildZip() {
  const files = [];
  const skipped = [];
  for (const e of state.entries) {
    if (!e.clip) continue;
    if (e.problem) {
      skipped.push({ key: e.key, reason: e.problem });
      continue;
    }
    files.push({ name: `${fileStem(e.key)}.wav`, data: e.clip.wav });
  }
  return { bytes: makeZip(files), names: files.map((f) => f.name), skipped };
}

function downloadZip() {
  const { bytes, names, skipped } = buildZip();
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "markerlist-voice-clips.zip";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  log(`ZIP: ${names.length} file(s), ${(bytes.length / 1e6).toFixed(2)} MB${skipped.length ? `; left out (name not allowed): ${skipped.map((s) => s.key).join(", ")}` : ""}.`);
}

// ---------------------------------------------------------------- wiring
els.file.addEventListener("change", () => {
  if (els.file.files[0]) loadFile(els.file.files[0]);
  els.file.value = "";
});
els.drop.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    els.file.click();
  }
});
for (const t of ["dragenter", "dragover"]) {
  els.drop.addEventListener(t, (ev) => {
    ev.preventDefault();
    els.drop.classList.add("over");
  });
}
for (const t of ["dragleave", "drop"]) {
  els.drop.addEventListener(t, (ev) => {
    ev.preventDefault();
    els.drop.classList.remove("over");
  });
}
els.drop.addEventListener("drop", (ev) => {
  const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (f) loadFile(f);
});
els.typedAdd.addEventListener("click", addTyped);
els.clear.addEventListener("click", clearList);
els.restore.addEventListener("click", restoreRemoved);
els.genMissing.addEventListener("click", () => generate(state.entries.filter((e) => usable(e) && !e.clip && !e.covered)));
els.genAll.addEventListener("click", () => generate(state.entries.filter((e) => usable(e) && !e.clip)));
els.download.addEventListener("click", downloadZip);
els.stop.addEventListener("click", () => {
  state.cancel = true;
  els.genProgress.textContent = "Stopping after the current clip…";
});
els.system.addEventListener("change", () => {
  state.system = els.system.value;
  refreshAll();
});

(async function init() {
  try {
    const res = await fetch(new URL("data/shipped.json", import.meta.url));
    state.shipped = (await res.json()).names;
  } catch (err) {
    log(`Could not read the list of clips shipped with the app: ${err.message}`);
  }
  refreshAll();
})();

// Handles for the automated checks (not used by the page itself).
window.__proto = { state, loadFile, addTyped, generate, buildZip, ensureEngine, clearList, renderAll, supported, formatSaved, removeEntry, restoreRemoved, refreshAll, MAX_CLIP_SECONDS, MAX_TEXT_CHARS };
