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
./fetch-deps.sh                 # stage occt-import-js 0.0.23 into vendor/ (pinned, sha256-checked)
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
- **Navigation.** Orbit (drag), pan (shift- or right-drag), zoom (wheel); the
  Iso / Front / Back / Left / Right / Top / Bottom views; fit; perspective or
  orthographic; Y-up or Z-up.
- **Touch.** One finger orbits; two fingers pinch to zoom and drag to pan; tap
  selects; double-tap zooms to the selection. Controls are finger-sized
  wherever a touch screen is present.
- **Phones and narrow windows.** Under 700 px wide, in portrait, or on a
  short touch screen (a landscape phone), the 3D view takes the full width,
  the parts tree folds into a **Parts** drawer below it, and the toolbar
  becomes one scrolling row with the view presets in a **View** dropdown.
  Rotating the device or opening the drawer keeps the same part of the model
  framed.
- **Keyboard and screen readers.** Open…, the tree (Enter selects, arrow keys
  expand and collapse) and every control are reachable from the keyboard;
  load results and errors are announced through a live region.
- **Parts.** Assembly tree with visibility checkboxes. Click in the tree or
  the scene to select (ctrl adds). Isolate / Hide / Show all; double-click
  zooms to the selection; hovering names the body under the cursor.
- **Inspect.** Selection extent (X × Y × Z) and triangle count. Section plane
  on X / Y / Z with a slider and a flip; the cut is left open, with no cap.
- **Colour.** File colours per body and per b-rep face. A file with no colours
  gets one muted colour per part name, so every instance of a part matches.
- **Save .cadmesh** after an in-browser import, so the next load skips
  tessellation.

## Large assemblies: convert once

OpenCascade tessellation runs single-threaded in WASM. A large multi-part
assembly can take minutes, in the browser and in Node alike. Convert it once
and serve the result:

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
| `js/mat4.js` | matrix helpers |
| `stp2mesh.mjs` | offline converter (same importer and packing code as the browser) |
| `fetch-deps.sh` | fetches occt-import-js |

## Tests

```sh
npm test        # tests/test-cadmesh.mjs + tests/test-camera.mjs
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
repository: `fetch-deps.sh` downloads the published npm tarball and copies its
licence files beside the runtime in `vendor/`.
