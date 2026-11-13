#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt.
#
# Rebuilds espeakng.js, espeakng.wasm and espeakng.data (eSpeak NG compiled to WebAssembly: English, French, Spanish, Portuguese) from the pinned sources.
# These three files are what vendor/espeak-ng/ ships; BUILD-INFO.txt lists the exact versions and the SHA-256 of every file this script is expected to produce.
#
#   ./build.sh                 build in ./work (tools in ./work/tools), write the three files to ./out, and compare them with BUILD-INFO.txt
#   WORK=/path TOOLS=/path OUT=/path ./build.sh     choose the folders (TOOLS keeps emsdk and cmake, about 1.5 GB, and is reused by later builds)
#
# Needs: git, python3 (3.10 or later), a C/C++ compiler (Xcode command line tools or gcc/clang), and network access to github.com, pypi.org and storage.googleapis.com.
# Nothing is fetched except what is listed below; CMake is told not to fetch anything by itself (FETCHCONTENT_FULLY_DISCONNECTED).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/work}"
TOOLS="${TOOLS:-$WORK/tools}"
OUT="${OUT:-$HERE/out}"

# ---- what is built from, pinned
ESPEAK_URL=https://github.com/espeak-ng/espeak-ng.git
ESPEAK_TAG=1.52.0
ESPEAK_COMMIT=4870adfa25b1a32b4361592f1be8a40337c58d6c
# eSpeak NG's CMake fetches this library by itself (even though we switch it off); it is pinned here and handed over so that nothing is fetched behind our back
SONIC_URL=https://github.com/waywardgeek/sonic.git
SONIC_COMMIT=fbf75c3d6d846bad3bb3d456cbc5d07d9fd8c104
EMSDK_URL=https://github.com/emscripten-core/emsdk.git
EMSDK_COMMIT=1693ce7359fc9694f198694f902a2cc061239b86
EMSCRIPTEN_VERSION=7.0.0
CMAKE_VERSION=4.4.4
LANGUAGES="en fr es pt"          # the dictionaries kept in the data package

say() { printf '\n== %s\n' "$*"; }
mkdir -p "$WORK" "$TOOLS" "$OUT"

# ---- 1. tools (kept between builds)
say "cmake $CMAKE_VERSION"
if [ ! -x "$TOOLS/venv_cmake/bin/cmake" ]; then
  python3 -m venv "$TOOLS/venv_cmake"
  "$TOOLS/venv_cmake/bin/python" -m pip install --disable-pip-version-check --only-binary :all: "cmake==$CMAKE_VERSION"
fi
export PATH="$TOOLS/venv_cmake/bin:$PATH"
cmake --version | head -1

say "emsdk $EMSDK_COMMIT, Emscripten $EMSCRIPTEN_VERSION"
if [ ! -d "$TOOLS/emsdk/.git" ]; then git clone "$EMSDK_URL" "$TOOLS/emsdk"; fi
git -C "$TOOLS/emsdk" checkout --quiet "$EMSDK_COMMIT"
(cd "$TOOLS/emsdk" && ./emsdk install "$EMSCRIPTEN_VERSION" && ./emsdk activate "$EMSCRIPTEN_VERSION")
# shellcheck disable=SC1091
source "$TOOLS/emsdk/emsdk_env.sh" > /dev/null
emcc --version | head -1
EM="$TOOLS/emsdk/upstream/emscripten"

# ---- 2. sources
say "eSpeak NG $ESPEAK_TAG ($ESPEAK_COMMIT)"
SRC="$WORK/espeak-ng"
if [ -d "$SRC" ]; then echo "removing the previous source tree $SRC"; rm -rf "$SRC"; fi
git clone --quiet --depth 1 --branch "$ESPEAK_TAG" "$ESPEAK_URL" "$SRC"
test "$(git -C "$SRC" rev-parse HEAD)" = "$ESPEAK_COMMIT" || { echo "the tag $ESPEAK_TAG does not point at $ESPEAK_COMMIT"; exit 1; }
for p in "$HERE"/patches/*.patch; do echo "applying $(basename "$p")"; git -C "$SRC" apply "$p"; done

SONIC="$WORK/sonic"
if [ ! -d "$SONIC/.git" ]; then
  git init --quiet "$SONIC"
  git -C "$SONIC" remote add origin "$SONIC_URL"
  git -C "$SONIC" fetch --quiet --depth 1 origin "$SONIC_COMMIT"
fi
git -C "$SONIC" checkout --quiet "$SONIC_COMMIT"
NOFETCH=(-DFETCHCONTENT_FULLY_DISCONNECTED=ON "-DFETCHCONTENT_SOURCE_DIR_SONIC-GIT=$SONIC")
OPTIONS=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DUSE_ASYNC=OFF -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=/usr)

# ---- 3. native build: its only purpose is to compile the data files (phonemes and dictionaries), which needs the espeak-ng program to RUN
say "native build (data files)"
rm -rf "$WORK/build-native"
cmake -S "$SRC" -B "$WORK/build-native" "${OPTIONS[@]}" "${NOFETCH[@]}" > "$WORK/native.log" 2>&1
cmake --build "$WORK/build-native" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" >> "$WORK/native.log" 2>&1
DATA="$WORK/build-native/espeak-ng-data"
test -f "$DATA/phontab"

# ---- 4. WebAssembly build of the libraries (only the library target: nothing has to run)
say "WebAssembly libraries"
rm -rf "$WORK/build-em"
emcmake cmake -S "$SRC" -B "$WORK/build-em" "${OPTIONS[@]}" "${NOFETCH[@]}" > "$WORK/em.log" 2>&1
cmake --build "$WORK/build-em" --target espeak-ng -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" >> "$WORK/em.log" 2>&1
LIB="$WORK/build-em/src"
test -f "$LIB/libespeak-ng/libespeak-ng.a"

# ---- 5. the data package: the shared phoneme data, the dictionaries of the languages we keep, every voice description (a few KB each)
say "data package ($LANGUAGES)"
PKG="$WORK/build-worker/data/espeak-ng-data"
rm -rf "$WORK/build-worker"
mkdir -p "$PKG"
for f in phontab phonindex phondata intonations; do cp -p "$DATA/$f" "$PKG/"; done
for l in $LANGUAGES; do cp -p "$DATA/${l}_dict" "$PKG/"; done
cp -Rp "$DATA/lang" "$DATA/voices" "$PKG/"

# ---- 6. bindings, glue and link
say "WebAssembly module"
cd "$WORK/build-worker"
python3 "$EM/tools/webidl_binder.py" "$SRC/emscripten/espeakng_glue.idl" glue
em++ -O3 -I"$SRC/src/include/espeak-ng" -I. -c "$SRC/emscripten/espeakng_glue.cpp" -o espeakng_glue.o
em++ -O3 espeakng_glue.o "$LIB/libespeak-ng/libespeak-ng.a" "$LIB/ucd-tools/libucd.a" "$LIB/speechPlayer/libspeechPlayer.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createESpeakNG -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 \
  "-sEXPORTED_RUNTIME_METHODS=FS,stringToUTF8,lengthBytesUTF8,UTF8ToString" "-sEXPORTED_FUNCTIONS=_malloc,_free" -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  --post-js glue.js --preload-file data/espeak-ng-data@/usr/share/espeak-ng-data \
  -o espeakng.js
cp -p espeakng.js espeakng.wasm espeakng.data "$OUT/"

# ---- 7. check against the recorded build
say "check against BUILD-INFO.txt"
cd "$OUT"
status=0
for f in espeakng.js espeakng.wasm espeakng.data; do
  got="$(shasum -a 256 "$f" | cut -c1-64)"
  want="$(grep -E "^sha256 $f " "$HERE/BUILD-INFO.txt" 2>/dev/null | awk '{print $3}' || true)"
  if [ -z "$want" ]; then echo "  $f  $got  (no recorded value)"; elif [ "$got" = "$want" ]; then echo "  $f  $got  identical to BUILD-INFO.txt"; else echo "  $f  $got  DIFFERENT from BUILD-INFO.txt ($want)"; status=1; fi
done
exit $status
