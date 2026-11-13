// SPDX-License-Identifier: GPL-3.0-or-later
// Settings of the site that serves this page. Loaded before app.js.
// Where the voice model (92 MB: onnx/model_quantized.onnx, tokenizer.json, voices/*.bin) is read from. Leave it empty to read it from the models/ folder next to this page;
// otherwise give the address of the folder, with a trailing slash. If it is on another server, that server must allow this page to read it (CORS).
window.VOICE_MODEL_BASE = "";
