// CAD viewer front end: backend selection (WebGPU -> WebGL2 -> WebGL1), loading
// (.cadmesh direct, .stp/.step/.igs/.brep through the OpenCascade worker),
// orbit camera, part tree, picking, section plane. Rendering is on demand.

import { decodeCadmesh } from './cadmesh.js';
import { lookAt, multiply, perspective, ortho } from './mat4.js';
import { WebGLRenderer } from './renderer-webgl.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const STATE_W = 1024;
const BG = [0.114, 0.129, 0.153];
const HIGHLIGHT = [1.0, 0.55, 0.1, 1];

const app = {
  status: 'init',
  backend: null,
  attempts: [],
  renderer: null,
  mesh: null,
  header: null,
  sourceName: '',
  lastStepBuffer: null,
  selected: new Set(),
  hidden: new Set(),
  hover: 0,
  cam: { target: [0, 0, 0], dist: 1000, yaw: 0.7, pitch: 0.45, fov: Math.PI / 4, ortho: false, up: 'y', radius: 500 },
  section: { axis: 'off', t: 0.5, flip: false },
  frameQueued: false,
  frameCount: 0,
};
window.__cadv = app;

function setStatus(s, msg) {
  app.status = s;
  $('status').textContent = msg || s;
  $('status').dataset.state = s;
}

// ---------- backend ----------

async function makeRenderer() {
  const order = { webgpu: ['webgpu'], webgl2: ['webgl2'], webgl1: ['webgl1'] }[params.get('backend')]
    || ['webgpu', 'webgl2', 'webgl1'];
  for (const name of order) {
    // A canvas keeps the first context type it hands out, so every attempt gets a fresh one.
    const old = $('view');
    const canvas = old.cloneNode(false);
    old.replaceWith(canvas);
    try {
      let r;
      if (name === 'webgpu') {
        const { WebGPURenderer } = await import('./renderer-webgpu.js');
        r = await WebGPURenderer.create(canvas);
      } else {
        r = WebGLRenderer.create(canvas, name === 'webgl2' ? 2 : 1);
      }
      app.attempts.push({ backend: name, ok: true });
      return r;
    } catch (e) {
      app.attempts.push({ backend: name, ok: false, error: String(e.message || e) });
      console.warn(`backend ${name} unavailable:`, e);
    }
  }
  throw new Error(`no GPU backend: ${app.attempts.map((a) => `${a.backend}: ${a.error}`).join('; ')}`);
}

// ---------- camera ----------

function upVec() {
  return app.cam.up === 'z' ? [0, 0, 1] : [0, 1, 0];
}

function camDir() {
  const { yaw, pitch } = app.cam;
  const cp = Math.cos(pitch);
  return app.cam.up === 'z'
    ? [cp * Math.sin(yaw), -cp * Math.cos(yaw), Math.sin(pitch)]
    : [cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)];
}

function frameState() {
  const c = app.cam;
  const r = app.renderer;
  const d = camDir();
  const eye = [c.target[0] + d[0] * c.dist, c.target[1] + d[1] * c.dist, c.target[2] + d[2] * c.dist];
  const up = Math.abs(c.pitch) > 1.5 ? (c.up === 'z' ? [-Math.sin(c.yaw), Math.cos(c.yaw), 0] : [-Math.sin(c.yaw), 0, -Math.cos(c.yaw)]) : upVec();
  const view = lookAt(eye, c.target, up);
  const w = r.canvas.width || 1, h = r.canvas.height || 1;
  const near = Math.max(c.dist - c.radius * 2, c.radius * 0.002);
  const far = c.dist + c.radius * 2.5;
  const zo = r.name === 'webgpu';
  const proj = c.ortho
    ? ortho(c.dist * Math.tan(c.fov / 2) * (w / h), c.dist * Math.tan(c.fov / 2), near, far, zo)
    : perspective(c.fov, w / h, near, far, zo);
  // key light: above and to the left of the viewer
  const right = [view[0], view[4], view[8]];
  const camUp = [view[1], view[5], view[9]];
  const light = [0, 1, 2].map((k) => d[k] + camUp[k] * 0.6 - right[k] * 0.4);
  return { viewProj: multiply(proj, view), eye, light, clip: sectionPlane(), highlight: HIGHLIGHT, background: BG };
}

function sectionPlane() {
  const s = app.section;
  if (s.axis === 'off' || !app.header || !app.header.bbox) return null;
  const k = { x: 0, y: 1, z: 2 }[s.axis];
  const { min, max } = app.header.bbox;
  const pos = min[k] + (max[k] - min[k]) * s.t;
  const n = [0, 0, 0];
  n[k] = s.flip ? -1 : 1;
  return [n[0], n[1], n[2], s.flip ? -pos : pos];
}

function fitTo(bbox) {
  if (!bbox) return;
  const c = app.cam;
  c.target = [0, 1, 2].map((k) => (bbox.min[k] + bbox.max[k]) / 2);
  const r = Math.hypot(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k])) / 2 || 1;
  c.dist = (r / Math.sin(c.fov / 2)) * 1.05;
  if (!app.header || bbox === app.header.bbox) c.radius = r;
  else c.radius = Math.max(c.radius, r);
  queueFrame();
}

const VIEWS = {
  iso: [0.7, 0.45], front: [0, 0], back: [Math.PI, 0], left: [-Math.PI / 2, 0],
  right: [Math.PI / 2, 0], top: [0, Math.PI / 2 - 1e-4], bottom: [0, -Math.PI / 2 + 1e-4],
};

function setView(v) {
  [app.cam.yaw, app.cam.pitch] = VIEWS[v];
  fitTo(app.header && app.header.bbox);
}

// ---------- drawing ----------

function queueFrame() {
  if (app.frameQueued || !app.renderer) return;
  app.frameQueued = true;
  requestAnimationFrame(() => {
    app.frameQueued = false;
    resize();
    app.renderer.render(frameState());
    app.frameCount++;
  });
}

function resize() {
  const r = app.renderer;
  const box = $('stage');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(box.clientWidth * dpr));
  const h = Math.max(1, Math.round(box.clientHeight * dpr));
  if (r.canvas.width !== w || r.canvas.height !== h) r.resize(w, h);
}

function pushState() {
  if (!app.header) return;
  const n = app.header.meshes.length + 1;
  const H = Math.ceil(n / STATE_W);
  const bytes = new Uint8Array(STATE_W * H * 4);
  for (const id of app.selected) bytes[id * 4] = 255;
  for (const id of app.hidden) bytes[id * 4 + 1] = 255;
  if (app.hover) bytes[app.hover * 4 + 2] = 255;
  app.renderer.setState(bytes, STATE_W, H);
  queueFrame();
}

// ---------- loading ----------

async function loadBuffer(buf, name) {
  const t0 = performance.now();
  const mesh = decodeCadmesh(buf);
  app.mesh = mesh;
  app.header = mesh.header;
  app.sourceName = name;
  app.selected.clear();
  app.hidden.clear();
  app.hover = 0;
  app.renderer.upload(mesh);
  pushState();
  buildTree();
  setView('iso');
  const tris = mesh.header.indexCount / 3;
  app.stats = { meshes: mesh.header.meshes.length, triangles: tris, vertices: mesh.header.vertexCount, uploadMs: Math.round(performance.now() - t0) };
  $('model').textContent = `${name} · ${mesh.header.meshes.length} bodies · ${fmtInt(tris)} triangles`;
  showInfo();
  setStatus('ready', 'ready');
}

const STEP_EXT = { stp: 'step', step: 'step', igs: 'iges', iges: 'iges', brep: 'brep' };

function extOf(name) {
  const m = /\.([a-z0-9]+)(?:$|\?)/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

async function loadAny(buf, name) {
  const ext = extOf(name);
  if (STEP_EXT[ext]) {
    app.lastStepBuffer = await tessellate(buf, STEP_EXT[ext]);
    $('export').disabled = false;
    return loadBuffer(app.lastStepBuffer, name);
  }
  return loadBuffer(buf, name);
}

function tessellate(buf, format) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./step-worker.js', import.meta.url));
    const t0 = performance.now();
    const tick = setInterval(() => {
      $('status').textContent = `${app.stepStage || 'working'} · ${Math.round((performance.now() - t0) / 1000)} s`;
    }, 1000);
    const done = (fn, v) => { clearInterval(tick); w.terminate(); fn(v); };
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') { app.stepStage = m.stage; setStatus('tessellating', m.stage); }
      else if (m.type === 'done') done(resolve, m.buffer);
      else done(reject, new Error(m.message));
    };
    w.onerror = (e) => done(reject, new Error(e.message || 'worker failed'));
    setStatus('tessellating', 'starting OpenCascade worker');
    w.postMessage({ buffer: buf, format }, [buf]);
  });
}

async function loadUrl(url) {
  setStatus('loading', `fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let buf;
  if (res.body && total) {
    const chunks = [];
    let got = 0;
    const rd = res.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      $('status').textContent = `fetching ${Math.round((100 * got) / total)}% of ${(total / 1e6).toFixed(1)} MB`;
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    buf = all.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  return loadAny(buf, url.split('/').pop());
}

async function loadFile(file) {
  setStatus('loading', `reading ${file.name}`);
  return loadAny(await file.arrayBuffer(), file.name);
}

function guard(p) {
  return p.catch((e) => {
    console.error(e);
    app.error = String(e.message || e);
    setStatus('error', app.error);
  });
}

// ---------- tree ----------

function collect(node, out = []) {
  for (const i of node.meshes) out.push(i + 1);
  for (const c of node.children) collect(c, out);
  return out;
}

// Label a body by the part that owns it: CAD exporters name bodies generically
// (Creo: COMPONENT1..n), while the tree carries the real part names.
function labelMeshes() {
  const labels = app.header.meshes.map((m) => m.name);
  const walk = (n, owner) => {
    const nm = n.name || owner;
    for (const i of n.meshes) {
      const mn = app.header.meshes[i].name;
      labels[i] = nm && nm !== mn ? `${nm} › ${mn}` : mn;
    }
    for (const c of n.children) walk(c, nm);
  };
  walk(app.header.root, '');
  app.meshLabel = labels;
}

const meshLabel = (id) => app.meshLabel[id - 1];

function buildTree() {
  labelMeshes();
  const root = $('tree');
  root.textContent = '';
  const mk = (node, depth) => {
    const ids = collect(node);
    if (!ids.length) return null;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    const kids = node.children.map((c) => mk(c, depth + 1)).filter(Boolean);
    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = kids.length ? (depth < 2 ? '▾' : '▸') : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    const label = document.createElement('span');
    label.className = 'label';
    const meshName = !node.name && node.meshes.length === 1 ? app.header.meshes[node.meshes[0]].name : '';
    label.textContent = node.name || meshName || '(unnamed)';
    label.title = `${ids.length} bod${ids.length === 1 ? 'y' : 'ies'}`;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = ids.length > 1 ? ids.length : '';
    row.append(tw, cb, label, cnt);
    li.append(row);
    li._ids = ids;
    li._cb = cb;
    if (kids.length) {
      const ul = document.createElement('ul');
      ul.append(...kids);
      ul.hidden = depth >= 2;
      li.append(ul);
      tw.onclick = () => { ul.hidden = !ul.hidden; tw.textContent = ul.hidden ? '▸' : '▾'; };
    }
    cb.onchange = () => {
      for (const id of ids) (cb.checked ? app.hidden.delete(id) : app.hidden.add(id));
      li.querySelectorAll('input').forEach((x) => { x.checked = cb.checked; });
      pushState();
    };
    label.onclick = (e) => select(ids, e.shiftKey || e.ctrlKey || e.metaKey);
    label.ondblclick = () => fitTo(bboxOf(ids));
    return li;
  };
  const top = mk(app.header.root, 0);
  if (top) root.append(top);
}

function syncTreeChecks() {
  document.querySelectorAll('#tree li').forEach((li) => {
    li._cb.checked = li._ids.some((id) => !app.hidden.has(id));
  });
  document.querySelectorAll('#tree .row').forEach((row) => {
    const li = row.parentElement;
    row.classList.toggle('sel', li._ids.length > 0 && li._ids.every((id) => app.selected.has(id)));
  });
}

// ---------- selection ----------

function bboxOf(ids) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const b = app.header.meshes[id - 1].bbox;
    if (!b) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
  }
  return min[0] === Infinity ? null : { min, max };
}

function select(ids, additive) {
  if (!additive) app.selected.clear();
  for (const id of ids) app.selected.add(id);
  pushState();
  syncTreeChecks();
  showInfo();
}

function showInfo() {
  const el = $('info');
  if (!app.header) { el.textContent = ''; return; }
  const ids = [...app.selected];
  const b = ids.length ? bboxOf(ids) : app.header.bbox;
  const dims = b ? [0, 1, 2].map((k) => (b.max[k] - b.min[k]).toFixed(1)).join(' × ') : '-';
  let title = 'whole model';
  if (ids.length === 1) title = meshLabel(ids[0]);
  else if (ids.length > 1) title = `${ids.length} bodies`;
  const tris = (ids.length ? ids.map((id) => app.header.meshes[id - 1].idxCount) : [app.header.indexCount]).reduce((a, x) => a + x, 0) / 3;
  el.innerHTML = '';
  const add = (k, v) => {
    const d = document.createElement('div');
    const a = document.createElement('b');
    a.textContent = k;
    d.append(a, ` ${v}`);
    el.append(d);
  };
  add('selection', title);
  add(`extent X × Y × Z (${app.header.units === 'millimeter' ? 'mm' : app.header.units})`, dims);
  add('triangles', fmtInt(tris));
}

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

// ---------- input ----------

function devicePx(e) {
  const c = app.renderer.canvas;
  const r = c.getBoundingClientRect();
  return [
    Math.min(c.width - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * c.width))),
    Math.min(c.height - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * c.height))),
  ];
}

app.pickAt = async (x, y) => app.renderer.pick(x, y, frameState());

function wireInput() {
  const stage = $('stage');
  let drag = null;
  let hoverT = 0;
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    const pan = e.button === 1 || e.button === 2 || e.shiftKey;
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan, moved: false };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) {
      if (!app.mesh || performance.now() - hoverT < 60) return;
      hoverT = performance.now();
      app.pickAt(...devicePx(e)).then((id) => {
        if (id !== app.hover) {
          app.hover = id;
          $('hover').textContent = id ? meshLabel(id) : '';
          pushState();
        }
      });
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 3) drag.moved = true;
    const c = app.cam;
    if (drag.pan) {
      const view = lookAt([0, 0, 0], camDir().map((v) => -v), upVec());
      const s = (2 * c.dist * Math.tan(c.fov / 2)) / stage.clientHeight;
      for (let k = 0; k < 3; k++) c.target[k] += (-dx * view[k * 4] + dy * view[k * 4 + 1]) * s;
    } else {
      c.yaw -= dx * 0.008;
      c.pitch = Math.max(-Math.PI / 2 + 1e-4, Math.min(Math.PI / 2 - 1e-4, c.pitch + dy * 0.008));
    }
    queueFrame();
  });
  stage.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (d && !d.moved && e.button === 0 && app.mesh) {
      app.pickAt(...devicePx(e)).then((id) => select(id ? [id] : [], e.ctrlKey || e.metaKey));
    }
  });
  stage.addEventListener('dblclick', () => {
    if (app.selected.size) fitTo(bboxOf([...app.selected]));
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    app.cam.dist *= Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015));
    app.cam.dist = Math.max(app.cam.radius * 0.01, Math.min(app.cam.radius * 50, app.cam.dist));
    queueFrame();
  }, { passive: false });
  window.addEventListener('resize', queueFrame);
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (f) guard(loadFile(f));
  });
  $('open').onchange = (e) => { if (e.target.files[0]) guard(loadFile(e.target.files[0])); };
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('fit').onclick = () => fitTo(app.selected.size ? bboxOf([...app.selected]) : app.header && app.header.bbox);
  $('proj').onclick = () => { app.cam.ortho = !app.cam.ortho; $('proj').textContent = app.cam.ortho ? 'ortho' : 'persp'; queueFrame(); };
  $('up').onclick = () => { app.cam.up = app.cam.up === 'y' ? 'z' : 'y'; $('up').textContent = `${app.cam.up.toUpperCase()}-up`; setView('iso'); };
  $('isolate').onclick = () => {
    if (!app.selected.size) return;
    app.hidden = new Set(app.header.meshes.map((_, i) => i + 1).filter((id) => !app.selected.has(id)));
    syncTreeChecks();
    pushState();
  };
  $('hide').onclick = () => {
    for (const id of app.selected) app.hidden.add(id);
    app.selected.clear();
    syncTreeChecks();
    pushState();
    showInfo();
  };
  $('showall').onclick = () => { app.hidden.clear(); syncTreeChecks(); pushState(); };
  $('secaxis').onchange = (e) => { app.section.axis = e.target.value; $('secpos').disabled = app.section.axis === 'off'; queueFrame(); };
  $('secpos').oninput = (e) => { app.section.t = Number(e.target.value) / 1000; queueFrame(); };
  $('secflip').onclick = () => { app.section.flip = !app.section.flip; queueFrame(); };
  $('export').onclick = () => {
    if (!app.lastStepBuffer) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([app.lastStepBuffer]));
    a.download = `${app.sourceName.replace(/\.[^.]+$/, '')}.cadmesh`;
    a.click();
  };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'f') $('fit').click();
    if (e.key === 'Escape') select([], false);
    if (e.key === 'h') $('hide').click();
    if (e.key === 'i') $('isolate').click();
    if (e.key === 'a') $('showall').click();
  });
}

// ---------- boot ----------

async function main() {
  setStatus('init', 'starting GPU');
  app.renderer = await makeRenderer();
  app.backend = app.renderer.name;
  $('backend').textContent = app.backend.toUpperCase();
  $('backend').title = `${app.renderer.adapterInfo || ''}\n${app.renderer.detail || ''}\n` +
    app.attempts.map((a) => `${a.backend}: ${a.ok ? 'ok' : a.error}`).join('\n');
  wireInput();
  queueFrame();
  const src = params.get('src');
  if (src) await loadUrl(src);
  else setStatus('idle', 'open or drop a .stp / .step / .igs / .cadmesh file');
}

// ?selftest=1: after loading, pick the canvas centre and publish one JSON line
// in <pre id="selftest"> so a headless `--dump-dom` run can grade the backend
// (tests/browser-smoke.sh). Runs on success and on failure.
async function selftest() {
  const out = { status: app.status, backend: app.backend, attempts: app.attempts, error: app.error || null };
  try {
    if (app.status === 'ready') {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = app.renderer.canvas;
      const id = await app.pickAt(c.width >> 1, c.height >> 1);
      Object.assign(out, { stats: app.stats, frames: app.frameCount, pickId: id, pickName: id ? meshLabel(id) : null });
    }
  } catch (e) {
    out.error = String(e.message || e);
  }
  const pre = document.createElement('pre');
  pre.id = 'selftest';
  pre.hidden = true;
  pre.textContent = `SELFTEST ${JSON.stringify(out)}`;
  document.body.append(pre);
}

guard(main()).then(() => { if (params.get('selftest')) return selftest(); });
