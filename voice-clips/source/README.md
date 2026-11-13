# eSpeak NG compiled to WebAssembly: source and recipe

This folder is the **corresponding source** of `vendor/espeak-ng/` (the files `espeakng.js`, `espeakng.wasm` and `espeakng.data`), as the GNU General Public License asks.
It is published with the tool, under the same licence (GPL-3.0-or-later, see `../licenses/GPL-3.0.txt`).

| File | What it is |
|---|---|
| `espeak-ng-1.52.0-source.tar.gz` | The unmodified source of eSpeak NG, tag 1.52.0 (commit `4870adfa25b1a32b4361592f1be8a40337c58d6c`), made with `git archive`. SHA-256 in `BUILD-INFO.txt`. Also at https://github.com/espeak-ng/espeak-ng |
| `patches/` | The two changes we make to that source (an include order that musl needs, and compact IPA output). Applied with `git apply` by the build script |
| `build.sh` | The build script: fetches the pinned tools and sources, applies the patches, builds, and compares the result with `BUILD-INFO.txt` |
| `BUILD-INFO.txt` | The exact versions of the source and of the tools, and the SHA-256 of the patches and of the three files the script produces |

## Rebuilding

```bash
./build.sh
```

It needs `git`, Python 3.10 or later, a C/C++ compiler and network access (github.com, pypi.org, storage.googleapis.com). It installs CMake 4.4.4 (PyPI) and Emscripten 7.0.0 (emsdk, pinned commit) under `./work/tools`
(about 1.5 GB, reused by later builds), builds in `./work`, writes the three files to `./out` and prints whether each is identical to the value recorded in `BUILD-INFO.txt`.
CMake is told not to fetch anything by itself: eSpeak NG's CMake files would otherwise download a library called sonic (not used by our build) on their own; the script fetches that library explicitly, at a pinned commit.

On 12/11/2026 a build from scratch produced `espeakng.wasm` and `espeakng.data` byte for byte identical to the first build, and the same `espeakng.js`.

## What the module contains

* eSpeak NG 1.52.0 (GPL-3.0-or-later), with its ucd-tools (GPL-3.0-or-later; Unicode character data, © 1991-2014 Unicode, Inc.) and speechPlayer (GPL-3.0-or-later, NV Access) libraries;
* the data package: the shared phoneme data, the dictionaries of English, French, Spanish and Portuguese, and every voice description;
* the Emscripten runtime and its C and C++ libraries (musl libc, MIT; libc++, Apache-2.0 with LLVM exceptions).

The JavaScript that uses the module (`lib/espeak.js`) is part of the tool and has the same licence.
