# cad-viewer

A static, dependency-free browser viewer for **STEP / IGES / BREP** CAD
assemblies. It renders with **WebGPU** and falls back to **WebGL2**, then
**WebGL1**. There is no build step and no CDN: serve the directory and open
`index.html`.

**Live: https://cad.place/** — drop a file on the page.

STEP files are tessellated by [OpenCascade](https://dev.opencascade.org/)
through [occt-import-js](https://github.com/kovacsv/occt-import-js) (WASM).
That happens either in a Web Worker in the page or offline with a Node
converter, which writes a compact, GPU-ready `.cadmesh` that loads instantly.

## Quick start

```sh
./fetch-deps.sh                 # stage occt-import-js into vendor/ (pinned, sha256-checked)
python3 -m http.server 8000     # or any static server
# open http://localhost:8000/   and drop a .stp/.step/.igs/.brep/.cadmesh on the page
```

WebGPU is only exposed in a **secure context** (https or localhost). Served
over plain http from another host, the viewer runs on WebGL2.

URL parameters:

| Parameter | Effect |
|---|---|
| `src=<url>` | load a `.cadmesh` or a STEP/IGES/BREP file on start |
| `backend=webgpu\|webgl2\|webgl1` | force one backend (default: try them in that order) |
| `selftest=1` | after loading, pick the canvas centre and publish one JSON line in `<pre id="selftest">` (for automated checks) |

## Features

- **Backends.** WebGPU with 4× MSAA; WebGL2; WebGL1, where a GPU without
  `OES_element_index_uint` gets a de-indexed stream. Each backend is attempted
  on a fresh canvas. WebGPU adapter/device requests time out after 6 s so that
  a hung request still falls back. The badge's tooltip says why any backend was
  skipped.
- **Navigation.** Orbit (drag) turns freely about every axis: over the top,
  upside down, round and round, with no stop at the poles. Pan (shift- or
  right-drag) and zoom (wheel). The Iso / Front / Back / Left / Right / Top /
  Bottom views each set a level, upright view again. Fit; perspective or
  orthographic; Y-up or Z-up.
- **Touch.** One finger orbits; two fingers pinch to zoom and drag to pan; tap
  selects; double-tap zooms to the selection. Controls are finger-sized
  wherever a touch screen is present.
- **Phones and narrow windows.** Under 700 px wide, in portrait, or on a
  short touch screen (a landscape phone), the 3D view takes the whole screen.
  The parts panel slides out from the left over the view (**☰ Parts** in the
  toolbar) and closes on a tap on the dimmed view, on Esc, or on the button.
  The toolbar becomes one scrolling row with the view presets in a **View**
  dropdown. Rotating the device keeps the same part of the model framed.
- **Keyboard and screen readers.** Every control is reachable from the
  keyboard. The parts tree is one tab stop: ↑ ↓ move, Enter selects, Space
  shows or hides, → ← open and close. Shortcuts: F fit, I isolate, H hide,
  A show all, Esc clear. Toggles report their state, and load results and
  errors are announced through a live region.
- **Parts.** An assembly tree with a row for every body, a filter box, and
  visibility checkboxes (half-checked when only some parts are shown).
  Repeated names are numbered. Click in the tree or the scene to select
  (ctrl adds); a pick in the scene opens and scrolls to its row. The
  selection is tinted cyan and the rest of the model is greyed, so it stands
  out whatever the model's colours. Isolate / Hide / Show all, with Undo
  (Ctrl/Cmd+Z) for each; double-click
  zooms to the selection; hovering names the body under the cursor, and on a
  touch screen a tap names what it picked.
- **Inspect.** Selection extent (X × Y × Z) and triangle count. Section plane
  on X / Y / Z with a slider, the cut's position in model units, and a flip.
  Cut solids read as solid: what you see of a part's inside through the cut
  is shaded flat, like a cut face.
- **Colour.** File colours per body and per b-rep face. A file with no colours
  gets one muted colour per part name, so every instance of a part matches.
- **Save .cadmesh** after an in-browser import, so the next load skips
  tessellation.
- **Saved conversions.** The browser also keeps each conversion itself, in
  IndexedDB on your device; nothing is uploaded. Opening the same file again
  skips OpenCascade (a 25.7 MB assembly: about 22 s to convert, 0.3 s from the
  saved copy, which takes 2.9 MB). A file is recognised by the SHA-256 of its
  bytes together with the tessellation settings; past 200 MB the least recently
  used are dropped. The parts panel shows how many are saved and how much space
  they take, with **Clear**.

## Large assemblies: convert once

OpenCascade tessellation runs single-threaded in WASM. A large multi-part
assembly can take a minute or more, in the browser and in Node alike (a
25.7 MB assembly: 41 s with our build, 597 s with the stock one). Convert
it once and serve the result:

```sh
node stp2mesh.mjs model.stp -o model.cadmesh --absolute 0.3 --angular 0.35
```

| Option | Meaning |
|---|---|
| `--deflection R` | linear deflection as a ratio of the bounding box (default 0.001) |
| `--absolute MM` | linear deflection as an absolute chord error, in mm |
| `--angular RAD` | angular deflection (default 0.5) |
| `--raw` | write the uncompressed layout (default: gzipped) |

The converter and **Save .cadmesh** write the file gzipped, usually about a
sixth of the raw size. The viewer inflates it with the browser's
`DecompressionStream`, so no web-server compression setup is needed. Raw
files load too.

## How it renders

- **One draw call for the whole model.** Every body shares one vertex and
  index buffer.
- **State texture.** Per-body flags (selected / hidden / hover) live in a
  small RGBA8 texture that the fragment shader reads by body id. Hiding or
  highlighting a part never re-uploads geometry.
- **Picking.** Each vertex carries its body id (mesh index + 1) as four RGBA
  bytes. The pick pass writes those bytes to a 1-pixel scissored RGBA8 target,
  and the read-back pixel *is* the id, identically on WebGPU, WebGL2 and WebGL1.
- **Depth.** Near and far planes are fitted to the model's bounding sphere
  from wherever the eye is. WebGPU uses reverse-Z on a `depth32float` buffer,
  so zooming onto a small part of a large assembly does not z-fight. WebGL
  keeps standard 24-bit depth.
- **GPU loss.** A lost WebGPU device or WebGL context is replaced (the
  fallback order applies again) and the model re-uploaded, up to 3 attempts.
- **`.cadmesh` sections.** The file's attribute sections (`float32x3`
  position, `snorm16x4` normal, `unorm8x4` colour and id, `uint32` index) are
  8-byte aligned and upload to the GPU without conversion once inflated. The layout is
  documented at the top of [`js/cadmesh.js`](js/cadmesh.js).

| File | Role |
|---|---|
| `index.html`, `js/main.js` | UI, tree, picking, section, loading, GPU-loss recovery |
| `js/camera.js` | orbit camera: view direction, up vector, fit, near/far |
| `js/renderer-webgpu.js` | WebGPU backend |
| `js/renderer-webgl.js` | WebGL2 + WebGL1 backend (one GLSL ES 1.00 shader set) |
| `js/cadmesh.js` | `.cadmesh` encode/decode, OpenCascade result mapping |
| `js/step-worker.js` | in-browser STEP/IGES/BREP import |
| `js/import-progress.js` | the conversion-time forecast, the time left and the progress bar |
| `js/step-features.js` | counts a STEP file's records, faces and holes per face, for the forecast |
| `js/mesh-cache.js` | the conversions kept in the browser (IndexedDB) |
| `js/mat4.js` | matrix helpers |
| `stp2mesh.mjs` | offline converter (same importer and packing code as the browser) |
| `fetch-deps.sh` | fetches occt-import-js: our build with progress reporting by default, `--stock` for the npm release |
| `occt-progress/` | `progress.patch` (our change to occt-import-js), `occt.patch` (our change to OpenCascade), `build.sh` (builds both) and `compare.sh` (checks two builds give byte-identical meshes) |

## Tests

```sh
npm test        # tests/test-cadmesh.mjs, test-camera.mjs, test-import-progress.mjs, test-mesh-cache.mjs
                # set CADV_STEP_FIXTURE=<file.stp> to add a real conversion
```

`tests/webgpu-offscreen.html?src=<.cadmesh>` drives the real WebGPU renderer
into an offscreen texture and checks the pick pass against the shaded frame:
every sampled lit pixel must pick a body, and every background pixel must pick
nothing. A CPU ray cast through each sampled pixel must name the same nearest
body as the GPU pick, which checks the depth setup; `&mutate=noreverse` breaks
it on purpose to show the check fails. It exists because headless Chromium on a software adapter (SwiftShader)
cannot present a WebGPU canvas, so the page itself cannot be graded there.

## Third-party

`occt-import-js` and OpenCascade are LGPL-2.1. They are not stored in this
repository. `fetch-deps.sh` downloads them, sha256-pinned, together with their
licence files, into `vendor/`.

By default it fetches **our build, `0.0.23-progress3`**. This is occt-import-js
0.0.23 built by `occt-progress/build.sh` (emscripten 3.1.69, the same
OpenCascade commit as upstream) with two patches:

- `progress.patch` passes OpenCascade's progress through the STEP and IGES
  transfer and the meshing to the page (`Module.onProgress(phase, fraction)`),
  so a conversion shows real progress. It also compiles with `-O3` instead of
  upstream's `-Oz` (a large import takes about 60% of the time, for a WASM
  about 28% larger gzipped), and copies the file into the WASM in one
  typed-array copy instead of one element at a time.
- `occt.patch` removes wasted work in OpenCascade: four loops, each quadratic
  in the number of wires (hole outlines) on a face, in shape healing
  (`ShapeFix_IntersectionTool`, `ShapeFix_Face`) and in the mesher's face check
  (`BRepMesh_FaceChecker`). Each now does its work only after the test that
  used to follow it, or without a copy. On a face with thousands of holes this
  was most of the conversion time.

The converted meshes are byte-identical to the stock build's:
`occt-progress/compare.sh` converts files with two builds and compares them
byte for byte (all 55 STEP/IGES/BREP test files of occt-import-js are
identical). The build is hosted at
`https://assets.known.name/occt-import-js/0.0.23-progress3/`, with a NOTICE;
the earlier `0.0.23-progress1` and `0.0.23-progress2` stay there too.
`./fetch-deps.sh --stock` uses the unmodified npm release instead, which reports
no steps; the page then shows the forecast alone.

The progress card's time left is a forecast for each step from what the file
holds: its size, its records, and how many holes its faces have, counted from
the file's text before the conversion starts. The forecast is scaled by this
device's speed, measured on the first step, and leans toward each step's own
pace as the step advances. The file size alone is a poor guide: a 5.7 MB part
with thousands of holes on one face can take fifteen times as long as an
ordinary 5.8 MB part. Progress also arrives unevenly: a step can sit for a
while on one large face. When a step outlasts its forecast or stops moving,
the card says "taking longer than expected" rather than guess.
`tests/estimate-calibrate.mjs` measures the data the forecast is fitted to,
and `tests/gen-holes-step.py` writes the many-holes test plates.
