MarkerList voice clips
======================

A free web page. It reads an Ableton Live set (.als), lists the song and section names
MarkerList can announce, speaks them in your browser with a neural voice (Kokoro-82M,
English) and gives you a ZIP of WAV clips for MarkerList's "tts_custom" folder.
Your set and your texts are never uploaded. A clip can last 2 seconds at most.

Licence
-------
Free software: GNU General Public License, version 3 or (at your option) any later
version (licenses/GPL-3.0.txt). No warranty.
The third-party components and their licences are listed in credits.html.

Source
------
Everything outside vendor/ is source: it is not compiled and not minified.

  vendor/onnxruntime-web/    ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4 (MIT),
                             unmodified files of the npm package "onnxruntime-web".
  vendor/espeak-ng/          eSpeak NG 1.52.0 (GPL-3.0-or-later) compiled to WebAssembly
                             by this project. Its source, our two patches, the build
                             script and the exact tool versions are in source/ (see
                             source/README.md); the script rebuilds the three files and
                             checks them against source/BUILD-INFO.txt.

Running it
----------
It is a static site: there is no build step. The page itself is built by the Markerlist website
around this folder: the two pages (index.html and credits.html) hold the tool's content, and the
website puts its own header, footer and consent banner around them. They are served from the same
address as this folder (https://markerlist.app/voice-clips/); "view source" there shows them as
they are. This folder holds the rest: the scripts, the styles (style.css), the voice engines and
the model. To run the tool on your own server, save those two pages next to the files of this
folder and serve it with any web server (for a quick test, run "python3 -m http.server" in this
folder and open http://localhost:8000/ ). It does not work from a file:// address.

The voice model (about 92 MB) is NOT part of the code files. By default the page reads it from
  models/onnx-community/Kokoro-82M-v1.0-ONNX/
next to the page (see model.json there: the model is cut in parts of at most 20 MB, so that
it can be uploaded with a browser). To keep it on another server instead, set
window.VOICE_MODEL_BASE in config.js; that server must then let this page read the files
(CORS: Access-Control-Allow-Origin). The page checks the SHA-256 fingerprint of the whole model
and refuses any other file.

Optional: if the server sends the headers
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
the voice uses several threads (about twice as fast). Without them it works on one thread.
