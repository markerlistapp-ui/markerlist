// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Text -> phonemes (IPA) with eSpeak NG, compiled to WebAssembly by this project from the pinned source described in espeak-build/ (see also credits.html).
// phonemize(text, language) has the same shape as the function of the phonemizer.js library this module replaces, so that lib/text_en.js does not care which one it is given:
// it returns the lines of phonemes eSpeak NG writes for the text (one line per clause, empty lines dropped).

import createESpeakNG from "../vendor/espeak-ng/espeakng.js";

/** The voices the packaged data can speak: English (American and British accents), French, Spanish (Spain and Latin America), Portuguese (Portugal and Brazil). */
export const LANGUAGES = ["en", "en-us", "en-gb", "fr", "fr-fr", "es", "es-419", "pt", "pt-br"];

let engine = null; // promise of { module, worker }, created on first use
let counter = 0;

// The packaged data (espeakng.data) is looked up relative to the PAGE (browser) or to the current folder (Node), not to this module: say where the files are.
// A browser wants an address; Node (the tests) wants a file path.
const FILES = new URL("../vendor/espeak-ng/", import.meta.url);
const IN_NODE = typeof process !== "undefined" && !!process.versions?.node && typeof globalThis.window === "undefined" && typeof globalThis.WorkerGlobalScope === "undefined";

function locateFile(file) {
  const url = new URL(file, FILES);
  return IN_NODE ? decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1") : url.href;
}

function start(options) {
  return createESpeakNG({ locateFile, ...options }).then((module) => ({ module, worker: new module.eSpeakNGWorker() }));
}

/** Phonemes of `text` in `language`, as the lines eSpeak NG writes (IPA, no separator between phonemes). `options` goes to the module factory (e.g. locateFile). */
export async function phonemize(text, language = "en-us", options = {}) {
  if (!LANGUAGES.includes(language)) throw new Error(`Invalid language identifier: "${language}". Should be one of: ${LANGUAGES.join(", ")}.`);
  engine ??= start(options);
  const { module, worker } = await engine;
  // Everything below is synchronous: two calls can never interleave between choosing the voice and speaking.
  if (worker.set_voice(language) !== 0) throw new Error(`eSpeak NG has no voice named "${language}".`);
  const file = `/ipa-${++counter}.txt`;
  const code = worker.synth_ipa_(String(text), file);
  if (code !== 0) return []; // the output file could not be opened: nothing was written, nothing to remove
  try {
    return module.FS.readFile(file, { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.length > 0);
  } finally {
    module.FS.unlink(file);
  }
}
