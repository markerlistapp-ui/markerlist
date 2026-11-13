// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Voice engine, running in a worker so that the page stays responsive while a clip is being computed.
// Kokoro-82M (int8 ONNX) through onnxruntime-web (WebAssembly), with eSpeak NG (WebAssembly, built by this project) for the phonemes.
// The libraries come from vendor/ next to this file; the model files from the address app.js gives (see config.js).
import * as ort from "./vendor/onnxruntime-web/ort.wasm.bundle.min.mjs";
import { phonemize } from "./lib/espeak.js";
import { phonemizeEnglish } from "./lib/text_en.js";
import { makeTokenizer, styleVector } from "./lib/tokens.js";

const CACHE_NAME = "markerlist-voice-v1";
const SAMPLE_RATE = 24000;

let session = null;
let tokenizer = null;
let config = null;
const voices = new Map();

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fetches one file of the voice model. A network or CORS failure is told in words a visitor can act on; the address itself goes to the page's log (app.js).
async function get(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error("The voice model could not be downloaded. Check your internet connection and try again.");
  }
  if (!res.ok) throw new Error(`The voice model could not be downloaded (error ${res.status}). Try again later.`);
  return res;
}

const FINGERPRINT_MESSAGE = "The voice model that was downloaded does not match its expected fingerprint, so it was not used.";

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    return null; // no Cache API (private window...): just download
  }
}

// A copy kept by the browser, if there is one AND it matches the fingerprint (a copy that does not is dropped).
async function cachedBytes(cache, url, expectedSha256) {
  if (!cache) return null;
  try {
    const hit = await cache.match(url);
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (!expectedSha256 || (await sha256Hex(bytes)) === expectedSha256) return bytes;
    await cache.delete(url);
  } catch (e) {
    /* unreadable cache entry: download again */
  }
  return null;
}

async function keepBytes(cache, url, bytes) {
  if (!cache) return;
  try {
    await cache.put(url, new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream" } }));
  } catch (e) {
    /* quota: the next visit downloads again, nothing else is lost */
  }
}

// Downloads one file. onChunk(n, total) says that n more bytes arrived (total: the size announced by the server, 0 if it did not say or if the number can not be compared).
// A host that compresses (GitHub Pages sends EVERY file with Content-Encoding: gzip) announces in Content-Length the size of the COMPRESSED body, while the browser hands us the decoded bytes:
// the two numbers can only be compared when the body is not encoded. Whatever the host does, whoever keeps the bytes checks them (size and SHA-256 of each part, then of the whole model, SHA-256 of the voice).
async function download(url, onChunk) {
  const res = await get(url);
  const encoded = (res.headers.get("content-encoding") || "identity").trim().toLowerCase() !== "identity";
  const total = encoded ? 0 : Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onChunk(value.length, total);
  }
  if (total && loaded !== total) throw new Error("The voice model could not be downloaded completely. Check your internet connection and try again.");
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return bytes;
}

// Downloads a file (or reads it back from the browser's cache). With `expectedSha256`, a file that does not match is never used and never
// cached: a cached copy that fails the check is dropped and downloaded again.
async function fetchBytes(url, onProgress, expectedSha256 = null) {
  const cache = await openCache();
  const hit = await cachedBytes(cache, url, expectedSha256);
  if (hit) {
    onProgress(hit.length, hit.length);
    return { bytes: hit, fromCache: true };
  }
  let loaded = 0;
  const bytes = await download(url, (n, total) => {
    loaded += n;
    onProgress(loaded, total);
  });
  if (expectedSha256 && (await sha256Hex(bytes)) !== expectedSha256) throw new Error(FINGERPRINT_MESSAGE);
  await keepBytes(cache, url, bytes);
  return { bytes, fromCache: false };
}

const isRelativePath = (file) => !/^[a-z][a-z0-9+.-]*:/i.test(file) && !file.startsWith("/") && !file.split("/").includes("..");

// model.json, next to the model files, describes the model cut in parts (a site that can only take small files, such as one filled by a browser upload, keeps it that way).
// null when there is no such file. The description is never trusted for what the model IS: the page pins the fingerprint of the whole file (msg.modelSha256).
async function readManifest(msg) {
  if (!msg.manifestUrl) return null;
  let res;
  try {
    res = await fetch(msg.manifestUrl);
  } catch (e) {
    throw new Error("The voice model could not be downloaded. Check your internet connection and try again.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The voice model could not be downloaded (error ${res.status}). Try again later.`);
  let m = null;
  try {
    m = await res.json();
  } catch (e) {
    m = null;
  }
  const valid =
    m && Array.isArray(m.parts) && m.parts.length > 0 && Number.isInteger(m.bytes) && (!msg.modelSha256 || m.sha256 === msg.modelSha256) &&
    m.parts.every((p) => p && typeof p.file === "string" && isRelativePath(p.file) && Number.isInteger(p.bytes) && p.bytes > 0 && /^[0-9a-f]{64}$/.test(p.sha256 || "")) &&
    m.parts.reduce((sum, p) => sum + p.bytes, 0) === m.bytes;
  if (!valid) throw new Error("The description of the voice model does not match this page.");
  return m;
}

// The model: from the browser's cache, else from its parts (each one checked as it arrives, then the whole), else from the single file.
async function fetchModel(msg, onProgress) {
  const cache = await openCache();
  const hit = await cachedBytes(cache, msg.modelUrl, msg.modelSha256 || null);
  if (hit) {
    onProgress(hit.length, hit.length);
    return { bytes: hit, fromCache: true, parts: 0 };
  }
  const manifest = await readManifest(msg);
  if (!manifest) return { ...(await fetchBytes(msg.modelUrl, onProgress, msg.modelSha256 || null)), parts: 0 };
  const bytes = new Uint8Array(manifest.bytes);
  let done = 0;
  for (const [i, part] of manifest.parts.entries()) {
    let partLoaded = 0;
    const got = await download(new URL(part.file, msg.manifestUrl).href, (n) => {
      partLoaded += n;
      onProgress(done + partLoaded, manifest.bytes);
    });
    if (got.length !== part.bytes || (await sha256Hex(got)) !== part.sha256) {
      throw new Error(`Part ${i + 1} of ${manifest.parts.length} of the voice model is damaged or incomplete. Check your internet connection and try again.`);
    }
    bytes.set(got, done);
    done += got.length;
  }
  if (msg.modelSha256 && (await sha256Hex(bytes)) !== msg.modelSha256) throw new Error(FINGERPRINT_MESSAGE);
  await keepBytes(cache, msg.modelUrl, bytes);
  return { bytes, fromCache: false, parts: manifest.parts.length };
}

async function loadVoice(name) {
  if (!voices.has(name)) {
    const { bytes } = await fetchBytes(`${config.voicesBase}${name}.bin`, () => {}, (config.voiceSha256 && config.voiceSha256[name]) || null); // a voice that does not match its fingerprint is never used nor kept
    voices.set(name, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  }
  return voices.get(name);
}

async function load(msg) {
  config = msg;
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = new URL("./vendor/onnxruntime-web/", import.meta.url).href;
  if (msg.threads) ort.env.wasm.numThreads = msg.threads;

  const vocabRes = await get(msg.vocabUrl);
  tokenizer = makeTokenizer((await vocabRes.json()).model.vocab);

  const t1 = performance.now();
  const { bytes, fromCache, parts } = await fetchModel(msg, (loaded, total) => self.postMessage({ type: "progress", loaded, total }));
  const t2 = performance.now();
  session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const t3 = performance.now();
  await loadVoice(msg.defaultVoice);
  self.postMessage({
    type: "ready",
    fromCache,
    verified: !!msg.modelSha256,
    modelBytes: bytes.length,
    modelParts: parts,
    threads: ort.env.wasm.numThreads,
    crossOriginIsolated: self.crossOriginIsolated,
    ms: { vocab: Math.round(t1 - t0), modelFetch: Math.round(t2 - t1), sessionCreate: Math.round(t3 - t2), total: Math.round(performance.now() - t0) },
  });
}

async function speak(msg) {
  const t0 = performance.now();
  const phonemes = await phonemizeEnglish(msg.text, phonemize, { american: msg.voice.startsWith("a") });
  const t1 = performance.now();
  const { ids, dropped, truncated } = tokenizer.encode(phonemes);
  const voice = await loadVoice(msg.voice);
  const feeds = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (n) => BigInt(n)), [1, ids.length]),
    style: new ort.Tensor("float32", styleVector(voice, ids), [1, 256]),
    speed: new ort.Tensor("float32", Float32Array.of(msg.speed || 1), [1]),
  };
  const out = await session.run(feeds);
  const samples = Float32Array.from(out.waveform.data);
  out.waveform.dispose();
  const t2 = performance.now();
  self.postMessage(
    {
      type: "clip",
      id: msg.id,
      samples,
      sampleRate: SAMPLE_RATE,
      phonemes,
      tokens: ids.length - 2,
      dropped,
      truncated,
      ms: { phonemize: Math.round(t1 - t0), inference: Math.round(t2 - t1), total: Math.round(t2 - t0) },
    },
    [samples.buffer],
  );
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "load") await load(msg);
    else if (msg.type === "speak") await speak(msg);
  } catch (e) {
    self.postMessage({ type: "error", id: msg.id, message: String((e && e.message) || e) });
  }
};
