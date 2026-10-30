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

A gzip-compressed model (`part.stp.gz`, about a sixth of the size to
download) opens too: the page unpacks it and opens the file inside.

WebGPU is only exposed in a **secure context** (https or localhost). Served
over plain http from another host, the viewer runs on WebGL2.

URL parameters:

| Parameter | Effect |
|---|---|
| `src=<url>` | load a `.cadmesh` or a STEP/IGES/BREP file on start; a file on another site loads only if that site sends CORS headers (`Access-Control-Allow-Origin`), as GitHub raw files, most CDNs and CORS-enabled buckets do |
| `list=<url>` | a model list: a JSON file of the models a site offers, `{"<file>": "<display name>", …}` (or an array of `[file, name]` pairs, which keeps any order), each file resolved against the list's own URL. A name may also be `{"name": "…", "orient": "up:+z,front:-y"}`, which opens that model turned that way (see `orient=`), with any of: `"step"`, the source CAD file, offered as File > **Download STEP**; `"page"`, the model's own page, linked from the info panel; `"image"`, a picture of it, shown in File > **Browse models…** (the list as a grid of pictures) and while it downloads; `"author"` and `"license"`, shown there; `"labels"`, `{"<a part's name>": "<what to call it>"}`, the names the parts show; `"style"`, the display style it opens in unless the visitor chose one; `"notes"`, `[{"text": "HDMI", "part": "<a part's name>"}]` or with `"at": [x, y, z]`, notes pinned on the model. A model opened from a STEP URL offers that file for download too. The names fill a drop-down beside Open…; picking one opens it into `?src=`. `list=` may repeat: the lists join in the URL's order, and a file named again keeps its first place. With no `src=` the first model opens. A list on another site needs CORS, as `src` does |
| `orient=up:+z,front:-y` | which of the file's axes is up and which faces the viewer in the Front view, whatever frame the file was drawn in: any two of `up`, `front` and `right`, each `+x` `-x` `+y` `-y` `+z` or `-z`, perpendicular (in a URL, `+` is written `%2B`). The view presets are taken in it and the model is fitted, so files drawn differently open the same way round. It applies to a model opened from a URL; a list entry's own `orient` wins, and a bad value is ignored |
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
  right-drag) and zoom (wheel, toward the point under the pointer). The Iso / Front / Back / Left / Right / Top /
  Bottom views each set a level, upright view again. Fit frames the model as
  the view sees it. On a portrait phone, Iso looks along a long model from
  its end, so a board's long side runs up the screen and it fills about twice
  as much of it; every board turns the same way. Perspective or orthographic;
  Y-up or Z-up.
- **Touch.** One finger orbits; two fingers pinch to zoom (toward the point
  between them) and drag to pan; tap selects; double-tap zooms to the
  selection. Controls are finger-sized wherever a touch screen is present.
  The first model a phone shows names these gestures for a few seconds, once.
- **Phones and narrow windows.** Under 700 px wide, in portrait, or on a
  short touch screen (a landscape phone), the 3D view takes the whole screen.
  The parts panel slides out from the left over the view (**☰** in the
  toolbar) and closes on a tap on the dimmed view, on Esc, or on the button.
  Open… and Save .cadmesh are in a **File** menu. Rotating the device keeps
  the same part of the model framed. The footer names the model in full and
  leaves the counts to the parts panel.
- **A toolbar that fits.** The toolbar stays one row at every size. Saving,
  exporting, links and the model gallery are in a **File** menu at every
  width; where the rest does not fit, the view presets fold first, into a
  **Views** menu, then Ortho, Z up, Section and Style (with the presets) into a **View** menu,
  then a model list's drop-down into File too, then Isolate / Hide /
  Show all / Undo into a **Show** menu, and on the narrowest phones Measure
  into View. No control shrinks or wraps its label to fit. A tool's own
  controls are in an **options bar** along the bottom of the view while the
  tool is on, led by the tool's name as a toggle that turns it off.
- **Full screen.** A button at the top right of the view takes the whole
  screen, toolbar and parts panel included, where the browser allows it.
- **Keyboard and screen readers.** Every control is reachable from the
  keyboard. The parts tree is one tab stop: ↑ ↓ move, Enter selects, Space
  shows or hides, → ← open and close. The 3D view is a tab stop named for its model; focused, the arrows turn it,
  Shift+arrows pan, + and − zoom. Shortcuts: F fit, M measure, P picture, I isolate,
  H hide, A show all, E edges, Esc clear. Number keys set the view, on the digit row or the
  numpad: 1 front, 3 right, 7 top, 0 iso, 9 the opposite view, 5 Ortho on
  or off. Toggles report their state, and load results and
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
- **Measure.** **Measure** (M) puts its tools in the options bar:
  **Distance** (two points: the length and its X, Y and Z parts), **Angle**
  (three points) and **Face** (the gap between two faces, the first flat).
  Points snap to corners, edge midpoints, hole centres (with the hole's
  diameter) and points on edges, and only to what you can see (except in
  Wire, X-ray and Hidden grey, which draw hidden edges); else to the surface
  under the pointer. On a touch screen a tap places a point, and a finger
  held still aims, its marker just above it. Results stay on the model as
  lines and labels, with a list to copy or remove them; Esc stops. **Note**
  pins a short text to a point of the model, and a copied view link carries
  the notes, so a link can point at "this connector".
- **Holes.** **List holes** (with a part selected: the board) lists its
  holes: diameter, position from the reference's corner, through-hole
  depth, and for each size how many and how far apart they lie; they are
  numbered on the model, and the table copies as CSV.
- **Export.** File > **Export as…** saves the parts shown as STL, 3MF (with
  colours) or GLB (with colours), turned the way the model opens: Z up for
  STL and 3MF, Y up for GLB.
- **Picture.** File > **Save picture** (P) saves the view as a PNG at twice
  its size, without the hover and selection highlights, with Measure's
  results drawn in.
- **Drawing.** File > **Save drawing (SVG)** saves the selected parts (or
  all shown) as a 1:1 drawing in mm, seen straight along the nearest view:
  their edges, with holes as true circles. Select the board alone for its
  outline and holes, e.g. for a case design. Hidden edges are not removed.
- **Explode.** Views > **Explode** (X) pulls the parts apart, with a slider
  for how far: by the assembly tree (subassemblies first, then their parts
  within them), or along X, Y or Z only. Clicking, the section and Fit work
  on the parts where they are drawn. Measure turns it off.
- **Flat sheets.** A board's pads, silkscreen and labels (the flat sheet
  bodies) can be hidden or shown in one go from the parts panel.
- **Embed.** `?embed=1` shows the model alone, for an `<iframe>` on a
  product page: no toolbar or panels, just Fit, full screen and **Open in
  cad.place ↗** over the view. Until a visitor clicks or taps it, it leaves
  the page's scrolling alone; Esc gives the scroll wheel back. With
  `&poster=<image URL>` it shows the picture first and downloads the model
  only when the visitor clicks **View in 3D**.
- **Facts.** The volume and surface area of the selection or the model
  (closed parts only for volume), and with parts selected their mass in a
  material you pick (PLA, ABS, PETG, aluminium, steel, brass, FR-4).
- **Axes.** The model's X, Y and Z turn with the view in a corner of it.
- **Inspect.** Selection extent (X × Y × Z), its position (each axis's
  extent from a reference's corner: the whole model, or the parts chosen
  with **Measure from selection**, such as the board, which also gives how far
  things stand above and below it), and triangle count. Section plane
  (View > Section): along the bottom of the view, X / Y / Z, a slider, the
  cut's position (click it to type one), a button that cuts through the
  selection, and a flip.
  Cut solids read as solid: what you see of a part's inside through the cut
  is shaded flat, like a cut face.
- **Units.** The parts panel names the unit the file was drawn in (read
  from a STEP or IGES file's own unit declarations; "not recorded" for an
  older `.cadmesh`) and shows lengths in it on **Auto** (in mm instead for
  a model drawn in metres that is under a metre across), or in mm, cm, m
  or in by choice, which the browser remembers.
- **Edges and display styles.** A model opens in Shaded. In Shaded + edges
  the b-rep face boundaries are drawn over the shaded faces (parts under
  6 px on screen draw none, and in the line styles are not drawn or picked
  at all). View > **Style**:
  Shaded (the default), Shaded + edges, Hidden line, Hidden
  grey (the selected or hovered parts' hidden edges dashed and lighter), Wire, or X-ray (translucent
  faces). The last four also draw the outlines of curved faces, and the
  hidden-line styles fill cut solids flat grey while a section is on (an
  open surface is not filled). **E** switches Shaded and Shaded + edges.
  The choice in the menu is remembered in the browser.
- **Share a view.** File > **Copy view link** copies a link that opens the
  model at the same view: camera, projection, up axis, style, section,
  hidden and selected parts (`?src=<model URL>#view=…`). A model opened from
  your device has no URL, so its link holds the view alone, and opened, it
  applies to the next model you open from your device. A link keeps the
  page's model lists. It also names the selected parts, so a link made
  before the model's file was revised still selects them.
- **Colour.** File colours per body and per b-rep face (STEP `COLOUR_RGB` and
  named colours), as the file gives them. STEP carries colour from AP214 on;
  an AP203 file, a common default export, has none, and gets one muted colour
  per part name, so every instance of a part matches. Transparency and
  per-instance colours in an assembly are not read.
- **Colour schemes.** *Colours* in the parts panel switches in one click:
  the file's colours, one colour per part name, per top-level assembly, per
  body, or one colour for everything. Remembered in this browser. Beside it, a
  colour picker recolours the selected parts (the colour shows once they are
  deselected), and Reset gives them the scheme's colour again (Reset all, with
  nothing selected). Picked colours are remembered in this browser for that
  model. Only what is drawn changes: Save .cadmesh and the saved conversions
  keep the file's colours.
- **Save .cadmesh** after an in-browser import, so the next load skips
  tessellation.
- **Saved conversions.** The browser also keeps each conversion itself, in
  IndexedDB on your device; nothing is uploaded. Opening the same file again
  skips OpenCascade (a 25.7 MB assembly: about 22 s to convert, 0.3 s from the
  saved copy, which takes 2.9 MB). A file is recognised by the SHA-256 of its
  bytes together with the tessellation settings; past 200 MB the least recently
  used are dropped. The parts panel shows how many are saved and how much space
  they take, with **Clear**.
- **Multi-core conversion.** On a desktop or laptop with 4 or more cores (and
  8 GB or more, where the browser says), a page served with cross-origin
  isolation headers (`_headers`: COOP and COEP) converts on the multi-core
  build, which meshes faces on up to 4 threads and gives the same triangles (a
  25.7 MB assembly in Chromium: about 25 s instead of 29). It needs more
  memory (1.6 GB of WASM at its peak against 0.7 GB), so phones and tablets
  always use one thread, and a multi-core conversion that fails is run again
  on one thread. The info panel says which ran.
- **Missing faces are reported.** A face the converter could not mesh is named
  in the status line and the info panel, and such a conversion is not saved.

## Large assemblies: convert once

OpenCascade tessellation runs in WASM, and only its meshing uses more than one
thread. A large multi-part
assembly can take a minute or more, in the browser and in Node alike (a
25.7 MB assembly: 43 s with our build, 39 s on its multi-core variant; 597 s
with the stock one, which also
runs out of WASM memory on its body with thousands of holes and leaves half
that body's faces unmeshed, without an error). Convert it once and serve the
result:

```sh
node stp2mesh.mjs model.stp -o model.cadmesh --absolute 0.3 --angular 0.35
```

| Option | Meaning |
|---|---|
| `--deflection R` | linear deflection as a ratio of the bounding box (default 0.001) |
| `--absolute MM` | linear deflection as an absolute chord error, in mm |
| `--angular RAD` | angular deflection (default 0.5) |
| `--raw` | write the uncompressed layout (default: gzipped) |
| `--threads` | the multi-core build: faces meshed on up to 4 threads, the same triangles, more memory |

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
  8-byte aligned and upload to the GPU without conversion once inflated.
  Optional sections, which older viewers ignore, add each b-rep face's
  triangles (`faces`); the header records the file's declared unit. The layout is
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
| `js/source-units.js` | the length unit a STEP or IGES file declares |
| `js/units.js` | formats every length, area, volume and mass in the display unit |
| `js/edges.js`, `js/edges-worker.js` | the edge list (face boundaries; silhouette candidates inside curved faces) and each body's closed / area / volume facts, built by the converter or, for an older `.cadmesh`, in a worker |
| `js/styles.js` | the display styles, their defaults and the paper edge colours |
| `js/view-link.js` | a view as a URL hash and back; parts by number, and by name when the model changed |
| `js/datum.js` | the selection's extent from a reference's corner, and how far it reaches above and below it |
| `js/measure-geom.js`, `js/raycast.js`, `js/measure-ui.js` | Measure and the hole table: a body's corners, edges, circles and holes from the b-rep faces; the ray caster (a BVH for big bodies); the snap search, modes, results and their layer over the view |
| `js/model-list.js` | `list=` files: parse, resolve, join in URL order, fetch with a size cap |
| `js/orient.js` | an orientation (`up:+z,front:-y`): parse, and the rotation the view presets are taken in |
| `js/face-order.js` | the faces' draw order: solids, then sheet bodies with less depth bias, so a sheet lying on a solid's face (a board's pads) shows |
| `js/mesh-cache.js` | the conversions kept in the browser (IndexedDB) |
| `js/palettes.js` | the colour schemes |
| `js/converter-choice.js` | whether an import runs on the multi-core build |
| `_headers` | the cross-origin isolation headers the multi-core build needs |
| `js/mat4.js` | matrix helpers |
| `stp2mesh.mjs` | offline converter (same importer and packing code as the browser) |
| `fetch-deps.sh` | fetches occt-import-js: our build with progress reporting by default, `--stock` for the npm release |
| `occt-progress/` | `progress.patch` (our change to occt-import-js), `occt.patch` (our change to OpenCascade), `build.sh` (builds both) and `compare.sh` (checks two builds give byte-identical meshes) |

## Tests

```sh
npm test        # tests/test-cadmesh.mjs, test-camera, test-import-progress, test-mesh-cache, test-palettes,
                # test-converter-choice, test-source-units, test-units, test-edges,
                # test-styles, test-view-link, test-face-order, test-datum, test-measure
                # set CADV_STEP_FIXTURE=<file.stp> to add a real conversion,
                # CADV_INCH_STEP=<an inch STEP file> to add a real inch file
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

By default it fetches **our build, `0.0.23-progress7`**. This is occt-import-js
0.0.23 built by `occt-progress/build.sh` (emscripten 3.1.69, the same
OpenCascade commit as upstream) with two patches:

- `progress.patch` passes OpenCascade's progress through the STEP and IGES
  transfer and the meshing to the page (`Module.onProgress(phase, fraction)`),
  so a conversion shows real progress. It also compiles with `-O3` instead of
  upstream's `-Oz` (a large import takes about 60% of the time, for a WASM
  about 28% larger gzipped), and copies the file into the WASM in one
  typed-array copy instead of one element at a time. Colours come back as the
  file gives them: OpenCascade keeps them as linear RGB, and the stock build
  returned that, which shows every mid-tone darker (0.5 as 0.21).
  Before meshing, it closes an open solid whose missing faces are planar: a
  closed loop of the solid's own free edges that lies in a plane, and is not a
  hole in a face that is still there, gets a face built on those edges, and
  coplanar loops nest into one face with holes. A solid gets all of its caps
  or none, and no existing face is rebuilt, so colours stay. A surface model (a
  shell outside any solid), a flat sheet and a non-planar hole are left as they
  are. Each body in the result says what it is (`brep_kind`: closed, capped,
  sheet or open), and the `.cadmesh` header keeps it as `kind`.
- `occt.patch` removes wasted work in OpenCascade: four loops, each quadratic
  in the number of wires (hole outlines) on a face, in shape healing
  (`ShapeFix_IntersectionTool`, `ShapeFix_Face`) and in the mesher's face check
  (`BRepMesh_FaceChecker`). Each now does its work only after the test that
  used to follow it, or without a copy. In the mesher's triangulation, the
  large circumcircles at the edge of the growing mesh go in a list of their own
  instead of every cell of its search grid (`BRepMesh_CircleTool`), and each
  edge's points are kept in vectors instead of 4 KB deques
  (`IMeshData_Types`): meshing a face with N holes now grows about N^1.1
  instead of N^1.5, and a face that ran WASM out of memory, which OpenCascade
  leaves unmeshed without an error, now meshes.

It comes in two builds of the same sources: single-threaded, and in `mt/` a
multi-core one (`build.sh --threads 4`): emscripten threads, OpenCascade's
thread pool capped at 4, and the mimalloc allocator, without which the threads
wait on the default allocator's lock and run slower than one. Both mesh the
same triangles.

Wherever the stock build meshes every face and no solid needed closing, the
converted geometry is byte-identical to its: `occt-progress/compare.sh` converts files with two
builds and compares them byte for byte (all 55 STEP/IGES/BREP test files of
occt-import-js). The build is hosted at
`https://assets.known.name/occt-import-js/0.0.23-progress7/`, with a NOTICE;
`progress3` and later stay there too.
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
