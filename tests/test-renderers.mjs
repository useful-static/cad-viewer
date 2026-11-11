#!/usr/bin/env node
// js/renderer-webgl.js and js/renderer-webgpu.js against recording stand-ins: a WebGL / WebGL2
// context and a WebGPU adapter + device that answer every call and record it. What is asserted is
// the renderers' own decisions -- which context they ask for, that a shader compile or link
// failure throws in words, that a software adapter is refused, the programs, pipelines and passes
// they build, the uniforms they write (the cut pull's uCutV and Explode's xp slots among them) and
// the WebGL1 body path's attribute layout -- never a picture, which no node can draw. The stand-ins
// keep no GL state: a call is recorded and answered with a fresh handle, so a check reads the
// call the renderer made, not what a GPU would do with it.
//   node tests/test-renderers.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { test, done } from './harness.mjs';
import { WebGLRenderer } from '../js/renderer-webgl.js';
import { WebGPURenderer } from '../js/renderer-webgpu.js';
import { BIAS_SOLID, BIAS_SHEET } from '../js/face-order.js';

// ---- the scene: two triangles (bodies 1 and 2; the first a solid, the second a sheet), two
// boundary edges, one silhouette candidate, a 3-body table (8 floats per body: its Explode
// direction texel, then its centre + radius texel; values 1..24 so each slot is told apart)
function scene() {
  const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const normal = new Int16Array([0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767, 0]);
  const color = new Uint8Array([200, 100, 50, 255, 200, 100, 50, 255, 10, 20, 30, 255, 10, 20, 30, 255]);
  const id = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]);
  const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const header = { meshes: [{ kind: 'solid', idxStart: 0, idxCount: 3 }, { kind: 'sheet', idxStart: 3, idxCount: 3 }] };
  const edges = new ArrayBuffer(2 * 32);
  const ef = new Float32Array(edges), eb = new Uint8Array(edges);
  ef.set([0, 0, 0, 1, 0, 0], 0); eb.set([1, 0, 0, 0, 9, 9, 9, 255], 24);
  ef.set([1, 1, 0, 0, 1, 0], 8); eb.set([2, 0, 0, 0, 9, 9, 9, 255], 56);
  const sil = new ArrayBuffer(48);
  new Float32Array(sil).set([0, 0, 0, 0, 1, 0], 0); new Uint8Array(sil).set([1, 0, 0, 0, 5, 5, 5, 255], 24);
  new Int16Array(sil).set([0, 0, 32767, 0, 32767, 0, 0, 0], 16);
  const table = new Float32Array(3 * 8);
  for (let i = 0; i < table.length; i++) table[i] = i + 1;
  return { mesh: { position, normal, color, id, index, header }, edges, sil, table };
}
function frame(extra = {}) {
  return {
    background: [1, 1, 1], viewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    eye: [0, 0, 5, 1], light: [0.1, 0.2, 0.9], up: [0, 1, 0], highlight: [0, 0, 0, 0],
    clip: [0, 0.6, 0.8, 0.5], cutPull: 0.1, cutPullBody: 0.2, fill: [0.5, 0.5, 0.5],
    edges: { widthPx: 1, hoverPx: 2, minPx: 6 }, cullFaces: true, focalPx: 100, explode: 0.5, hoverId: 2,
    ground: { c: [0, 0, -1], ax: [2, 0, 0], ay: [0, 2, 0], alpha: 0.3 },
    style: { faces: 'shade', outline: true }, ...extra,
  };
}
const f32 = (a) => Array.from(a, (x) => Math.round(x * 1e4) / 1e4);

// ---- a recording WebGL / WebGL2 context. Enum names (gl.FLOAT ...) read as their own names; a
// create* call answers a handle { kind, n }; getUniformLocation answers { u: name }. ----
function fakeGL({ version = 2, compileOk = true, linkOk = true, vtu = 16, missing = [] } = {}) {
  const log = [];
  let n = 0;
  const ext = (name) => (missing.includes(name) ? null : new Proxy({ ext: name }, {
    get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? k
      : (...a) => { log.push({ k: `${name}.${String(k)}`, a }); }),
  }));
  const impl = {
    getParameter: (p) => ({ MAX_VIEWPORT_DIMS: [8192, 8192], MAX_VERTEX_TEXTURE_IMAGE_UNITS: vtu, RENDERER: 'stand-in' }[p] ?? 8192),
    getExtension: ext,
    getShaderParameter: () => compileOk,
    getProgramParameter: () => linkOk,
    getShaderInfoLog: () => 'ERROR: 0:3: \'x\' : undeclared identifier',
    getProgramInfoLog: () => 'varyings do not match',
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getError: () => 'NO_ERROR',
    isContextLost: () => false,
    checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE',
    getUniformLocation: (p, name) => ({ u: name, p }),
    getAttribLocation: () => 0,
  };
  const canvas = {
    width: 64, height: 64, clientWidth: 64, clientHeight: 64, asked: [],
    getContext(name, attrs) { this.asked.push(name); this.attrs = attrs; return (version === 2 ? name === 'webgl2' : name === 'webgl') ? gl : null; },
    addEventListener() {},
  };
  const gl = new Proxy({}, {
    get: (t, k) => {
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z_0-9]+$/.test(k)) return k;
      // the drawing buffer follows the canvas, capped at 4096 (a browser's size cap)
      if (k === 'drawingBufferWidth') return Math.min(canvas.width, 4096);
      if (k === 'drawingBufferHeight') return Math.min(canvas.height, 4096);
      return (...a) => {
        log.push({ k, a });
        if (impl[k]) return impl[k](...a);
        if (k.startsWith('create')) return { kind: k.slice(6), n: ++n };
        return undefined;
      };
    },
  });
  // the calls since the last mark
  let at = 0;
  const since = () => { const s = log.slice(at); at = log.length; return s; };
  return { gl, canvas, log, since };
}
const named = (calls, k) => calls.filter((c) => c.k === k);
const uni = (calls, name) => calls.filter((c) => /^uniform/.test(c.k) && c.a[0] && c.a[0].u === name).map((c) => c.a.slice(1).flatMap((x) => (x && typeof x === 'object' ? Array.from(x) : [x])));

// (r112 M renderer-webgl-C0: a WebGL2 request asked the canvas for a WebGL1 context)
await test('WebGL: create(canvas, 2) asks the canvas for "webgl2" only, create(canvas, 1) for "webgl" then "experimental-webgl"; none is said (r112 M renderer-webgl-C0)', () => {
  const g2 = fakeGL({ version: 2 });
  const r2 = WebGLRenderer.create(g2.canvas, 2);
  assert.deepEqual(g2.canvas.asked, ['webgl2']);
  assert.equal(r2.version, 2);
  assert.equal(r2.name, 'webgl2');
  assert.equal(g2.canvas.attrs.antialias, true);
  assert.equal(g2.canvas.attrs.powerPreference, 'high-performance');
  const g1 = fakeGL({ version: 1 });
  const r1 = WebGLRenderer.create(g1.canvas, 1);
  assert.deepEqual(g1.canvas.asked, ['webgl']);
  assert.equal(r1.name, 'webgl1');
  const none = { asked: [], getContext(n) { this.asked.push(n); return null; } };
  assert.throws(() => WebGLRenderer.create(none, 2), /^Error: WebGL2 context unavailable$/);
  assert.deepEqual(none.asked, ['webgl2']);
  none.asked = [];
  assert.throws(() => WebGLRenderer.create(none, 1), /^Error: WebGL1 context unavailable$/);
  assert.deepEqual(none.asked, ['webgl', 'experimental-webgl']);
});

// (r112 M renderer-webgl-B0, -R0: a failed compile went on to link; compile() returned no shader)
await test('WebGL: a shader that does not compile throws its info log, a program that does not link throws its log; built, every program gets the two shaders it compiled (r112 M renderer-webgl-B0 R0)', () => {
  const bad = fakeGL({ compileOk: false });
  assert.throws(() => WebGLRenderer.create(bad.canvas, 2), { message: 'shader: ERROR: 0:3: \'x\' : undeclared identifier' });
  assert.equal(named(bad.log, 'attachShader').length, 0, 'nothing attached after a failed compile');
  const unlinked = fakeGL({ linkOk: false });
  assert.throws(() => WebGLRenderer.create(unlinked.canvas, 2), { message: 'link: varyings do not match' });
  const g = fakeGL();
  WebGLRenderer.create(g.canvas, 2);
  const shaders = named(g.log, 'createShader');
  const attached = named(g.log, 'attachShader');
  // (shade, pick, fill, edges, ground: five programs, a vertex and a fragment shader each)
  assert.equal(named(g.log, 'createProgram').length, 5);
  assert.equal(attached.length, 10);
  assert.deepEqual(shaders.map((c) => c.a[0]), Array.from({ length: 5 }, () => ['VERTEX_SHADER', 'FRAGMENT_SHADER']).flat());
  for (const c of attached) {
    assert.ok(c.a[1] && c.a[1].kind === 'Shader', 'a compiled shader attached');
  }
  // (each attached shader is the one created, sourced and compiled for it)
  const compiled = named(g.log, 'compileShader').map((c) => c.a[0]);
  assert.deepEqual(attached.map((c) => c.a[1]), compiled);
  assert.equal(named(g.log, 'linkProgram').length, 5);
});

// (r112 M renderer-webgl-O5: one vertex texture unit read as none)
await test('WebGL1: the body table is a vertex texture (CULL_TEX) with OES_texture_float and one vertex texture unit, attributes (CULL_ATTR, aBody 4, aXd 5) with none (r112 M renderer-webgl-O5)', () => {
  const cases = [
    [{ version: 1, vtu: 1 }, true], [{ version: 1, vtu: 16 }, true], [{ version: 1, vtu: 0 }, false],
    [{ version: 1, vtu: 1, missing: ['OES_texture_float'] }, false], [{ version: 2, vtu: 0 }, true],
  ];
  for (const [cfg, tex] of cases) {
    const g = fakeGL(cfg);
    const r = WebGLRenderer.create(g.canvas, cfg.version);
    assert.equal(r.bodyTexOk, tex, JSON.stringify(cfg));
    const vs = named(g.log, 'shaderSource').filter((c, i) => i % 2 === 0).slice(0, 4).map((c) => c.a[1]);
    for (const src of vs) assert.ok(src.startsWith(tex ? '#define CULL_TEX\n' : '#define CULL_ATTR\n'), `${JSON.stringify(cfg)}: the face and edge vertex shaders' cull`);
    const binds = named(g.log, 'bindAttribLocation');
    const faceBinds = binds.filter((c) => c.a[0] === r.shade.p).map((c) => `${c.a[1]}:${c.a[2]}`);
    assert.deepEqual(binds.filter((c) => c.a[0] === r.edgeProg.p).map((c) => c.a[2]).slice(7), tex ? [] : ['aBody', 'aXd'], 'the edges\' too');
    assert.deepEqual(faceBinds, ['0:aPos', '1:aNrm', '2:aCol', '3:aId', ...(tex ? [] : ['4:aBody', '5:aXd'])], `${JSON.stringify(cfg)}: the face program's attributes`);
  }
});

// a renderer on a recording context, the scene uploaded and its edges given
async function glScene(cfg, opts) {
  const g = fakeGL(cfg);
  const r = WebGLRenderer.create(g.canvas, cfg.version, opts);
  const s = scene();
  await r.upload(s.mesh);
  g.since();
  return { g, r, s };
}

// (r112 M renderer-webgl-C19: CULL_ATTR edges uploaded raw, with no body slot, under a 64 / 80 byte stride)
await test('WebGL1 CULL_ATTR: each edge instance is uploaded with a 32-byte body slot after it (no table yet: never culled); WebGL2 uploads the data as given (r112 M renderer-webgl-C19)', async () => {
  const { g, r, s } = await glScene({ version: 1, vtu: 0 });
  r.uploadEdges(s.mesh, s.edges, s.sil);
  const bd = named(g.since(), 'bufferData').map((c) => c.a[1]);
  assert.deepEqual(bd.map((d) => d.byteLength), [2 * 64, 80], 'edges 32 + 32, outline edges 48 + 32 bytes each');
  assert.deepEqual(r.edgeLay, { expanded: false, inst: 0, body: 32, stride: 64, verts: 1 });
  assert.deepEqual(r.silLay, { expanded: false, inst: 0, body: 48, stride: 80, verts: 1 });
  const e = new Uint8Array(bd[0]);
  assert.deepEqual(Array.from(e.subarray(0, 32)), Array.from(new Uint8Array(s.edges, 0, 32)), 'the instance as given');
  assert.deepEqual(Array.from(e.subarray(64, 96)), Array.from(new Uint8Array(s.edges, 32, 32)));
  assert.deepEqual(Array.from(new Float32Array(bd[0], 32, 8)), [0, 0, 0, 1e30, 0, 0, 0, 0].map(Math.fround), 'no table: radius 1e30');
  // (the table come: packed again, each edge's body centre + radius, then its Explode direction)
  r.setBodies(s.mesh, s.table);
  const again = named(g.since(), 'bufferData').map((c) => c.a[1]).filter((d) => d instanceof ArrayBuffer);
  assert.equal(again.length, 2);
  assert.deepEqual(f32(new Float32Array(again[0], 32, 7)), [13, 14, 15, 16, 9, 10, 11], 'edge 0, body 1');
  assert.deepEqual(f32(new Float32Array(again[0], 64 + 32, 7)), [21, 22, 23, 24, 17, 18, 19], 'edge 1, body 2');
  // (two-sided: WebGL2's body table is a texture, the edges uploaded as given)
  const two = await glScene({ version: 2 });
  two.r.uploadEdges(two.s.mesh, two.s.edges, two.s.sil);
  const bd2 = named(two.g.since(), 'bufferData').map((c) => c.a[1]);
  assert.equal(bd2[0], two.s.edges);
  assert.equal(bd2[1], two.s.sil);
});

// (r112 M renderer-webgl-B26, -R11: a CULL_ATTR setBodies went to the float-texture path / made no buffers)
await test('WebGL1 CULL_ATTR setBodies: each drawn vertex\'s body (centre, radius) and Explode direction in two vertex buffers, no texture (r112 M renderer-webgl-B26 R11)', async () => {
  const { g, r, s } = await glScene({ version: 1, vtu: 0 });
  r.setBodies(s.mesh, s.table);
  const calls = g.since();
  assert.equal(named(calls, 'texImage2D').length, 0, 'no body texture');
  assert.equal(named(calls, 'bindTexture').length, 0);
  const fbd = named(calls, 'bufferData').filter((c) => c.a[1] instanceof Float32Array).map((c) => f32(c.a[1]));
  assert.deepEqual(fbd, [
    [13, 14, 15, 16, 13, 14, 15, 16, 21, 22, 23, 24, 21, 22, 23, 24],
    [9, 10, 11, 12, 9, 10, 11, 12, 17, 18, 19, 20, 17, 18, 19, 20],
  ]);
  assert.ok(r.faceBodyBuf && r.faceXdBuf);
  assert.equal(r.faceBodiesFor, s.mesh);
  assert.ok(r._cullReady('faces'), 'the faces\' cull can run');
  assert.equal(r._explode(frame()), 0.5, 'and Explode');
});

// (r112 M renderer-webgl-B51, -C39: aBody / aXd left as the edge pass left them; built bodies ignored)
await test('WebGL1 CULL_ATTR faces: before the table, aBody / aXd are constants no cull or Explode reaches; after it, the per-vertex buffers at 4 and 5 (r112 M renderer-webgl-B51 C39)', async () => {
  const { g, r, s } = await glScene({ version: 1, vtu: 0 });
  r.uploadEdges(s.mesh, s.edges, s.sil);
  g.since();
  r.render(frame());
  const before = g.since();
  const sh = r.shade.p;
  const first = before.findIndex((c) => c.k === 'useProgram' && c.a[0] === sh);
  const end = before.findIndex((c, i) => i > first && c.k === 'drawElements');
  const bind = before.slice(first, end);
  assert.deepEqual(bind.filter((c) => /Attrib/.test(c.k)).map((c) => `${c.k}(${c.a.join(',')})`), [
    'enableVertexAttribArray(0)', 'vertexAttribPointer(0,3,FLOAT,false,0,0)',
    'enableVertexAttribArray(1)', 'vertexAttribPointer(1,4,SHORT,true,0,0)',
    'enableVertexAttribArray(2)', 'vertexAttribPointer(2,4,UNSIGNED_BYTE,true,0,0)',
    'enableVertexAttribArray(3)', 'vertexAttribPointer(3,4,UNSIGNED_BYTE,true,0,0)',
    'disableVertexAttribArray(4)', 'vertexAttrib4f(4,0,0,0,1e+30)', 'disableVertexAttribArray(5)', 'vertexAttrib4f(5,0,0,0,0)',
  ]);
  assert.deepEqual(uni(bind, 'uXp'), [[0, 0, 0, 0]], 'no Explode without the table');
  r.setBodies(s.mesh, s.table);
  g.since();
  r.render(frame());
  const after = g.since();
  const f2 = after.findIndex((c) => c.k === 'useProgram' && c.a[0] === sh);
  const bind2 = after.slice(f2, after.findIndex((c, i) => i > f2 && c.k === 'drawElements'));
  const attr = bind2.filter((c) => /Attrib|bindBuffer/.test(c.k)).slice(-6).map((c) => `${c.k}(${c.a.map((x) => (x === r.faceBodyBuf ? 'faceBody' : x === r.faceXdBuf ? 'faceXd' : x)).join(',')})`);
  assert.deepEqual(attr, [
    'bindBuffer(ARRAY_BUFFER,faceBody)', 'enableVertexAttribArray(4)', 'vertexAttribPointer(4,4,FLOAT,false,0,0)',
    'bindBuffer(ARRAY_BUFFER,faceXd)', 'enableVertexAttribArray(5)', 'vertexAttribPointer(5,4,FLOAT,false,0,0)',
  ]);
  assert.equal(named(bind2, 'vertexAttrib4f').length, 0);
  assert.deepEqual(uni(bind2, 'uXp'), [[0.5, 0, 0, 0]], 'Explode with it');
  // (the cull on: focal px, 6 px, then on)
  assert.deepEqual(uni(bind2, 'uCull'), [[100, 6, 0, 1]]);
});

// (r112 M renderer-webgl-O158: the body texture's border argument 1)
await test('WebGL setBodies: the body table as a float texture -- RGBA32F on WebGL2, RGBA on WebGL1, its width the texel count, border 0, NEAREST (r112 M renderer-webgl-O158)', async () => {
  for (const [cfg, internal] of [[{ version: 2 }, 'RGBA32F'], [{ version: 1, vtu: 1 }, 'RGBA']]) {
    const { g, r, s } = await glScene(cfg);
    r.setBodies(s.mesh, s.table);
    const calls = g.since();
    const tex = named(calls, 'texImage2D');
    assert.equal(tex.length, 1);
    assert.deepEqual(tex[0].a.slice(0, 8), ['TEXTURE_2D', 0, internal, 6, 1, 0, 'RGBA', 'FLOAT']);
    assert.deepEqual(f32(tex[0].a[8]), f32(s.table));
    assert.deepEqual(named(calls, 'texParameteri').map((c) => c.a.slice(1).join('=')), ['TEXTURE_MIN_FILTER=NEAREST', 'TEXTURE_MAG_FILTER=NEAREST', 'TEXTURE_WRAP_S=CLAMP_TO_EDGE', 'TEXTURE_WRAP_T=CLAMP_TO_EDGE']);
    assert.deepEqual(r.bodySize, [6, 1]);
  }
});

// (r112 M renderer-webgl-O310: the cap normal's z read from the plane's offset)
await test('WebGL faces: the cut writes uCapN (the plane\'s normal), uClipV, and uCutV (on, the pull, the bodies\' pull once the table is the drawn mesh\'s) (r112 M renderer-webgl-O310)', async () => {
  for (const cfg of [{ version: 2 }, { version: 1, vtu: 0 }]) {
    const { g, r, s } = await glScene(cfg);
    r.render(frame());
    let c = g.since();
    assert.deepEqual(uni(c, 'uCapN').map(f32), [[0, 0.6, 0.8, 0]], `${cfg.version}: the plane's normal, not its offset`);
    assert.deepEqual(uni(c, 'uClipV').map(f32), [[0, 0.6, 0.8, 0.5]]);
    assert.deepEqual(uni(c, 'uCutV').map(f32), [[1, 0.1, 0, 0]], 'no table: every body pulled alike');
    r.setBodies(s.mesh, s.table);
    g.since();
    r.render(frame());
    c = g.since();
    assert.deepEqual(uni(c, 'uCutV').map(f32), [[1, 0.1, 0.2, 0]], 'with it: the bodies\' pull too');
    r.render(frame({ clip: null }));
    c = g.since();
    assert.deepEqual(uni(c, 'uCapN').map(f32), [[0, 0, 1, 0]], 'no cut: a default normal');
    assert.deepEqual(uni(c, 'uCutV').map(f32), [[0, 0.1, 0, 0]]);
  }
});

// (r112 M renderer-webgl-R21: resize did nothing)
await test('WebGL resize: the canvas takes the size asked, then shrinks to the drawing buffer the browser gave; the request kept; render\'s viewport the canvas (r112 M renderer-webgl-R21)', async () => {
  const { g, r } = await glScene({ version: 2 });
  r.resize(5000, 60);
  assert.deepEqual([g.canvas.width, g.canvas.height], [4096, 60]);
  assert.deepEqual(r.requested, [5000, 60]);
  r.resize(80, 60);
  assert.deepEqual([g.canvas.width, g.canvas.height], [80, 60]);
  assert.deepEqual(r.requested, [80, 60]);
  g.since();
  r.render(frame());
  assert.deepEqual(named(g.since(), 'viewport').map((c) => c.a), [[0, 0, 80, 60]]);
});

// (r113 M2 renderer-webgl-R24: the ground shadow never drawn)
await test('WebGL ground: a frame with a ground uses the ground program, writes its centre, axes and alpha, and draws a 4-vertex strip; a frame without one does not (r113 M2 renderer-webgl-R24)', async () => {
  const { g, r } = await glScene({ version: 2 });
  r.render(frame());
  const c = g.since();
  assert.ok(named(c, 'useProgram').some((x) => x.a[0] === r.groundProg.p), 'the ground program used');
  assert.deepEqual(uni(c, 'uGc').map(f32), [[0, 0, -1, 0]]);
  assert.deepEqual(uni(c, 'uGx').map(f32), [[2, 0, 0, 0]]);
  assert.deepEqual(uni(c, 'uGy').map(f32), [[0, 2, 0, 0]]);
  assert.deepEqual(uni(c, 'uGa').map(f32), [[0.3, 0, 0, 0]]);
  assert.deepEqual(named(c, 'drawArrays').map((x) => x.a), [['TRIANGLE_STRIP', 0, 4]]);
  r.render(frame({ ground: null }));
  const c2 = g.since();
  assert.equal(named(c2, 'useProgram').filter((x) => x.a[0] === r.groundProg.p).length, 0, 'no ground, no ground program');
  assert.deepEqual(named(c2, 'drawArrays'), []);
});

// ---- a recording WebGPU adapter and device ----
const flags = (names) => Object.fromEntries(names.map((k, i) => [k, 1 << i]));
globalThis.GPUShaderStage = flags(['VERTEX', 'FRAGMENT', 'COMPUTE']);
globalThis.GPUBufferUsage = flags(['MAP_READ', 'MAP_WRITE', 'COPY_SRC', 'COPY_DST', 'INDEX', 'VERTEX', 'UNIFORM', 'STORAGE', 'INDIRECT', 'QUERY_RESOLVE']);
globalThis.GPUTextureUsage = flags(['COPY_SRC', 'COPY_DST', 'TEXTURE_BINDING', 'STORAGE_BINDING', 'RENDER_ATTACHMENT']);
globalThis.GPUMapMode = flags(['READ', 'WRITE']);
const U = globalThis.GPUBufferUsage;

function fakeGPU({ info = { vendor: 'acme', architecture: 'rdna9' }, lostEarly = false, maxStorage = 1 << 27, isFallbackAdapter } = {}) {
  const log = [];
  let n = 0;
  // lose(info): the device lost after creation (its lost promise resolves then)
  let lose = null;
  const lostLater = new Promise((res) => { lose = res; });
  // an object whose every method is recorded ({ on, k, a }) and answers another such object
  const rec = (name, impl = {}) => new Proxy({ name }, {
    get: (t, k) => {
      if (k in impl) return impl[k];
      if (k in t || typeof k !== 'string' || k === 'then') return t[k];
      return (...a) => { log.push({ on: name, k, a }); return rec(`${k}#${++n}`); };
    },
  });
  const made = (kind, d) => ({ kind, d, n: ++n });
  const buffer = (d) => {
    const b = made('buffer', d);
    const ab = new ArrayBuffer(d.size);
    return Object.assign(b, {
      getMappedRange: () => ab, unmap: () => {}, destroy: () => { b.destroyed = true; log.push({ on: 'buffer', k: 'destroy', a: [b] }); },
      mapAsync: async () => {}, data: ab,
    });
  };
  const limits = { maxTextureDimension2D: 8192, maxBufferSize: 1 << 30, maxStorageBufferBindingSize: maxStorage };
  const queue = rec('queue');
  const device = rec('device', {
    limits, queue,
    lost: lostEarly ? Promise.resolve({ reason: 'unknown', message: 'early' }) : lostLater,
    addEventListener: () => {},
    pushErrorScope: () => {},
    popErrorScope: async () => null,
    createRenderPipeline: (d) => { const p = made('pipeline', d); p.getBindGroupLayout = () => ({}); log.push({ on: 'device', k: 'createRenderPipeline', a: [d], r: p }); return p; },
    createBuffer: (d) => { const b = buffer(d); log.push({ on: 'device', k: 'createBuffer', a: [d], r: b }); return b; },
    createTexture: (d) => { const t = made('texture', d); t.createView = () => ({ view: t }); t.destroy = () => {}; log.push({ on: 'device', k: 'createTexture', a: [d], r: t }); return t; },
    createBindGroup: (d) => { const b = made('bindGroup', d); log.push({ on: 'device', k: 'createBindGroup', a: [d], r: b }); return b; },
    createCommandEncoder: () => rec('encoder', {
      beginRenderPass: (d) => { log.push({ on: 'encoder', k: 'beginRenderPass', a: [d] }); return rec('pass'); },
      finish: () => ({ cmd: true }),
    }),
  });
  const adapter = { info, limits, isFallbackAdapter, requestDevice: async (d) => { log.push({ on: 'adapter', k: 'requestDevice', a: [d] }); return device; } };
  const gpu = { requestAdapter: async (o) => { log.push({ on: 'gpu', k: 'requestAdapter', a: [o] }); return adapter; }, getPreferredCanvasFormat: () => 'bgra8unorm' };
  const canvas = { width: 64, height: 64, getContext: (name) => { log.push({ on: 'canvas', k: 'getContext', a: [name] }); return rec('ctx'); } };
  Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true, writable: true });
  let at = 0;
  const since = () => { const s = log.slice(at); at = log.length; return s; };
  return { canvas, log, since, device, lose };
}
const on = (calls, o, k) => calls.filter((c) => c.on === o && c.k === k);

// (r112 M renderer-webgpu-R2, -B3: create returned nothing; a software adapter taken)
await test('WebGPU create: a hardware adapter gives a WebGPURenderer on a "webgpu" context; a software one is refused in words unless allowSoftware (r112 M renderer-webgpu-R2 B3)', async () => {
  const hw = fakeGPU();
  const r = await WebGPURenderer.create(hw.canvas);
  assert.ok(r instanceof WebGPURenderer);
  assert.equal(r.name, 'webgpu');
  assert.equal(r.adapterInfo, 'acme rdna9');
  assert.deepEqual(on(hw.log, 'gpu', 'requestAdapter')[0].a, [{ powerPreference: 'high-performance' }]);
  assert.deepEqual(on(hw.log, 'canvas', 'getContext').map((c) => c.a[0]), ['webgpu']);
  assert.deepEqual(on(hw.log, 'adapter', 'requestDevice')[0].a[0].requiredLimits, { maxBufferSize: 1 << 30, maxTextureDimension2D: 8192 });
  const sw = fakeGPU({ info: { vendor: 'google', architecture: 'swiftshader' } });
  await assert.rejects(WebGPURenderer.create(sw.canvas), (e) => e.message === 'software WebGPU adapter (google swiftshader): WebGL tried first' && e.software === true);
  assert.equal(on(sw.log, 'adapter', 'requestDevice').length, 0, 'no device asked of it');
  const fb = fakeGPU({ info: {}, isFallbackAdapter: true });
  await assert.rejects(WebGPURenderer.create(fb.canvas), { message: 'software WebGPU adapter (fallback): WebGL tried first' });
  const ok = fakeGPU({ info: { vendor: 'google', architecture: 'swiftshader' } });
  assert.ok(await WebGPURenderer.create(ok.canvas, { allowSoftware: true }) instanceof WebGPURenderer);
  const lost = fakeGPU({ lostEarly: true });
  await assert.rejects(WebGPURenderer.create(lost.canvas), { message: 'WebGPU device was lost at creation' });
});

// (r113 M2 renderer-webgpu-R3: a device lost after creation set no flag and called no onlost)
await test('WebGPU device lost while shown: lost becomes true and onlost is called once with the loss\'s message; a destroyed device sets lost but calls no onlost (r113 M2 renderer-webgpu-R3)', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [reason, want] of [['unknown', ['GPU reset']], ['destroyed', []]]) {
      const g = fakeGPU();
      const r = await WebGPURenderer.create(g.canvas);
      const calls = [];
      r.onlost = (m) => calls.push(m);
      assert.equal(r.lost, false);
      g.lose({ reason, message: 'GPU reset' });
      await new Promise((res) => setTimeout(res, 0));
      assert.equal(r.lost, true, reason);
      assert.equal(r.isLost(), true, reason);
      assert.deepEqual(calls, want, reason);
    }
  } finally {
    console.warn = warn;
  }
});

// (r112 M renderer-webgpu-C1, -O18, -R14: no face pipelines made; the body buffer 65 bytes; no state texture)
await test('WebGPU construction: the face pipelines (shade, pick, depth, xray, ghost, fill for the solids, then the sheets, each with its bias) and the ground\'s; a 64-byte body buffer; a 1x1 state texture bound (r112 M renderer-webgpu-C1 O18 R14)', async () => {
  const g = fakeGPU();
  const r = await WebGPURenderer.create(g.canvas);
  const pipes = on(g.log, 'device', 'createRenderPipeline').map((c) => c.a[0]);
  assert.equal(pipes.length, 13);
  const kinds = ['shade', 'pick', 'depth', 'xray', 'ghost', 'fill'];
  const fs = { shade: 'fsShade', pick: 'fsPick', depth: 'fsShade', xray: 'fsShade', ghost: 'fsGhost', fill: 'fsFill' };
  for (const [set, bias] of [[r.solidPipes, BIAS_SOLID], [r.sheetPipes, BIAS_SHEET]]) {
    assert.deepEqual(Object.keys(set), kinds);
    for (const k of kinds) {
      const d = set[k].d;
      assert.equal(d.fragment.entryPoint, fs[k], k);
      assert.equal(d.depthStencil.depthBias, -2 * bias[1], `${k}: the bias, negative under reverse-Z`);
      assert.equal(d.depthStencil.depthBiasSlopeScale, -bias[0]);
      assert.equal(d.multisample.count, k === 'pick' ? 1 : 4);
      assert.equal(d.depthStencil.depthWriteEnabled, !['xray', 'ghost', 'fill'].includes(k), `${k}: writes depth`);
    }
    assert.equal(set.depth.d.fragment.targets[0].writeMask, 0, 'depth only');
    assert.equal(set.fill.d.depthStencil.depthCompare, 'greater-equal');
    assert.equal(set.pick.d.fragment.targets[0].format, 'rgba8unorm');
  }
  assert.notEqual(r.solidPipes.shade, r.sheetPipes.shade);
  assert.equal(pipes[12].fragment.entryPoint, 'fsGround');
  // (made once: a frame's draw asks again and nothing is made)
  r.facePipes();
  assert.equal(on(g.log, 'device', 'createRenderPipeline').length, 13);
  const bufs = on(g.log, 'device', 'createBuffer').map((c) => c.a[0]);
  assert.deepEqual(bufs[0], { size: 64, usage: U.STORAGE | U.COPY_DST }, 'the empty body table');
  assert.equal(r.bodyBuf, on(g.log, 'device', 'createBuffer')[0].r);
  const tex = on(g.log, 'device', 'createTexture');
  assert.equal(tex.length, 1);
  assert.deepEqual(tex[0].a[0].size, [1, 1]);
  assert.equal(tex[0].a[0].format, 'rgba8unorm');
  assert.equal(on(g.log, 'queue', 'writeTexture').length, 1);
  assert.deepEqual([r.stateW, r.stateH], [1, 1]);
  assert.ok(r.bind && r.bind.kind === 'bindGroup', 'the group bound');
  const entries = r.bind.d.entries;
  assert.deepEqual(entries.map((e) => e.binding), [0, 1, 2]);
  assert.equal(entries[0].resource.buffer, r.ubo);
  assert.equal(entries[1].resource.view, r.stateTex);
  assert.equal(entries[2].resource.buffer, r.bodyBuf);
});

async function gpuScene(cfg) {
  const g = fakeGPU(cfg);
  const r = await WebGPURenderer.create(g.canvas);
  const s = scene();
  await r.upload(s.mesh);
  await r.uploadEdges(s.mesh, s.edges, s.sil);
  r.resize(80, 60);
  g.since();
  return { g, r, s };
}
// the uniform buffer's floats a render wrote
const ubo = (calls, r) => on(calls, 'queue', 'writeBuffer').filter((c) => c.a[0] === r.ubo).map((c) => f32(c.a[2]));

// (r112 M renderer-webgpu-B17: a table over the storage limit bound anyway)
await test('WebGPU setBodies: the table in a storage buffer of its size, bound; one over the device\'s storage binding limit is refused (no cull, the model drawn) (r112 M renderer-webgpu-B17)', async () => {
  const { g, r, s } = await gpuScene({});
  const old = r.bodyBuf;
  r.setBodies(s.mesh, s.table);
  const c = g.since();
  const nb = on(c, 'device', 'createBuffer');
  assert.deepEqual(nb.map((x) => x.a[0]), [{ size: 96, usage: U.STORAGE | U.COPY_DST }]);
  assert.deepEqual(on(c, 'queue', 'writeBuffer').map((x) => [x.a[0], x.a[1], x.a[2]]), [[nb[0].r, 0, s.table]]);
  assert.ok(old.destroyed, 'the empty one let go');
  assert.equal(r.bind.d.entries[2].resource.buffer, nb[0].r, 'and the new one bound');
  assert.equal(r.bodiesFor, s.mesh);
  const small = await gpuScene({ maxStorage: 64 });
  const before = small.r.bodyBuf;
  small.r.setBodies(small.s.mesh, small.s.table);
  assert.deepEqual(small.g.since(), [], 'nothing made, written or bound');
  assert.equal(small.r.bodyBuf, before);
  assert.equal(small.r.bodiesFor, null);
});

// (r112 M renderer-webgpu-C7, -O93: the face alpha slot set outside X-ray; the light's z read past its end)
await test('WebGPU uniforms: the light at 20, the cut plane at 24, the face alpha at 31 only in X-ray, Explode / ghost / cut pull / the bodies\' pull at 56 (r112 M renderer-webgpu-C7 O93)', async () => {
  const { g, r, s } = await gpuScene({});
  r.render(frame());
  let u = ubo(g.since(), r)[0];
  assert.equal(u.length, 64);
  assert.deepEqual(u.slice(16, 20), [0, 0, 5, 1], 'the eye');
  assert.deepEqual(u.slice(20, 24), [0.1, 0.2, 0.9, 0], 'the light');
  assert.deepEqual(u.slice(24, 28), [0, 0.6, 0.8, 0.5], 'the cut plane');
  assert.deepEqual(u.slice(28, 32), [1, 1, 1, 0], 'state size, cut on, opaque faces');
  assert.deepEqual(u.slice(40, 44), [80, 60, 1, 2], 'the canvas, the edge widths');
  assert.deepEqual(u.slice(48, 52), [100, 6, 0, 0], 'no table: no cull');
  assert.deepEqual(u.slice(56, 60), [0, 0, 0.1, 0], 'no table: no Explode, no bodies\' pull');
  r.render(frame({ style: { faces: 'xray', faceAlpha: 0.25 } }));
  u = ubo(g.since(), r)[0];
  assert.equal(u[31], 0.25, 'X-ray: its alpha');
  r.render(frame({ style: { faces: 'xray' } }));
  assert.equal(ubo(g.since(), r)[0][31], 1, 'X-ray with no alpha given: 1');
  r.setBodies(s.mesh, s.table);
  r.render(frame({ ghost: 0.3 }));
  u = ubo(g.since(), r)[0];
  assert.deepEqual(u.slice(48, 52), [100, 6, 1, 1], 'the table: edges and faces culled');
  assert.deepEqual(u.slice(56, 60), [0.5, 0.3, 0.1, 0.2], 'Explode, ghost, the cut pull, the bodies\' pull');
  r.render(frame({ clip: null }));
  u = ubo(g.since(), r)[0];
  assert.deepEqual(u.slice(24, 32), [0, 0, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(u.slice(56, 60), [0.5, 0, 0.1, 0], 'no cut: no bodies\' pull');
});

// (r112 M renderer-webgpu-O168: the ground's alpha slot's first float 1)
await test('WebGPU ground: its uniforms the view, centre, axes and (0, 0, 0, alpha), drawn first as a 4-vertex strip (r112 M renderer-webgpu-O168)', async () => {
  const { g, r } = await gpuScene({});
  r.render(frame());
  const c = g.since();
  const gw = on(c, 'queue', 'writeBuffer').filter((x) => x.a[0] === r.groundUbo).map((x) => f32(x.a[2]));
  assert.equal(gw.length, 1);
  assert.equal(gw[0].length, 32);
  assert.deepEqual(gw[0].slice(16), [0, 0, -1, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0.3]);
  const pass = c.filter((x) => x.on === 'pass');
  assert.deepEqual(pass.slice(0, 3).map((x) => x.k), ['setPipeline', 'setBindGroup', 'draw']);
  assert.equal(pass[0].a[0], r.groundPipe);
  assert.deepEqual(pass[2].a, [4]);
});

// the pass's calls as "setPipeline(<which>)", "drawIndexed(a,b,c)", "draw(a,b)"
function passCalls(calls, r) {
  const name = (p) => {
    for (const [set, w] of [[r.solidPipes, 'solid'], [r.sheetPipes, 'sheet']]) for (const [k, v] of Object.entries(set)) if (v === p) return `${w}.${k}`;
    if (p === r.groundPipe) return 'ground';
    for (const [k, v] of r.edgePipes) if (v === p) return `edge.${k}`;
    return '?';
  };
  return calls.filter((x) => x.on === 'pass' && /^(setPipeline|draw|drawIndexed)$/.test(x.k)).map((x) => (x.k === 'setPipeline' ? `setPipeline(${name(x.a[0])})` : `${x.k}(${x.a.join(',')})`));
}

// (r112 M renderer-webgpu-B32: the hidden-line styles' cut fill never drawn)
await test('WebGPU passes: shaded faces (solids, then sheets), then the edges and outline; the hidden-line style\'s depth-only faces then the cut fill, only with a cut and a fill (r112 M renderer-webgpu-B32)', async () => {
  const { g, r } = await gpuScene({});
  r.render(frame());
  assert.deepEqual(passCalls(g.since(), r), [
    'setPipeline(ground)', 'draw(4)',
    'setPipeline(solid.shade)', 'drawIndexed(3)', 'setPipeline(sheet.shade)', 'drawIndexed(3,1,3)',
    'setPipeline(edge.lequal|false)', 'draw(4,2)', 'setPipeline(edge.lequal|true)', 'draw(4,1)',
  ]);
  r.render(frame({ style: { faces: 'depth' }, ground: null, edges: null }));
  assert.deepEqual(passCalls(g.since(), r), [
    'setPipeline(solid.depth)', 'drawIndexed(3)', 'setPipeline(sheet.depth)', 'drawIndexed(3,1,3)',
    'setPipeline(solid.fill)', 'drawIndexed(3)', 'setPipeline(sheet.fill)', 'drawIndexed(3,1,3)',
  ]);
  r.render(frame({ style: { faces: 'depth' }, ground: null, edges: null, clip: null }));
  assert.deepEqual(passCalls(g.since(), r), ['setPipeline(solid.depth)', 'drawIndexed(3)', 'setPipeline(sheet.depth)', 'drawIndexed(3,1,3)'], 'no cut: no fill');
  r.render(frame({ style: { faces: 'depth' }, ground: null, edges: null, fill: null }));
  assert.equal(passCalls(g.since(), r).length, 4, 'no fill colour: no fill');
});

// (r112 M renderer-webgpu-C14, -R26: the edges of the drawn mesh never drawn; the pass bodies skipped)
await test('WebGPU edges: each pass writes its own slot (mode, dash, selected-only, then plain / selected / faded colours) and draws the edges and, outlined, the silhouettes; edges of another mesh are not drawn (r112 M renderer-webgpu-C14 R26)', async () => {
  const { g, r, s } = await gpuScene({});
  const passes = [{ depth: 'lequal', mode: 1, dash: 0, colours: { plain: [0.1, 0.2, 0.3], selected: [1, 0, 0] } }, { depth: 'greater', mode: 2, dash: 1, selectedOnly: true }];
  r.render(frame({ edgePasses: passes, ground: null, style: { faces: 'none', outline: true } }));
  const c = g.since();
  assert.deepEqual(passCalls(c, r), [
    'setPipeline(edge.lequal|false)', 'draw(4,2)', 'setPipeline(edge.lequal|true)', 'draw(4,1)',
    'setPipeline(edge.greater|false)', 'draw(4,2)', 'setPipeline(edge.greater|true)', 'draw(4,1)',
  ]);
  assert.equal(r.passSlots.length, 2);
  const slots = on(c, 'queue', 'writeBuffer').filter((x) => r.passSlots.some((p) => p.buf === x.a[0]));
  assert.deepEqual(slots.map((x) => [r.passSlots.findIndex((p) => p.buf === x.a[0]), f32(x.a[2])]), [
    [0, [1, 0, 0, 0, 0.1, 0.2, 0.3, 1, 1, 0, 0, 1, 0, 0, 0, 1]],
    [1, [2, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]],
  ]);
  // (each draw binds the corner strip at 0, the instances at 1, the pass's slot at group 1)
  const vb = c.filter((x) => x.on === 'pass' && x.k === 'setVertexBuffer');
  assert.deepEqual(vb.slice(0, 2).map((x) => [x.a[0], x.a[1]]), [[0, r.cornerBuf], [1, r.edgeBuf]]);
  assert.deepEqual(vb.slice(2, 4).map((x) => [x.a[0], x.a[1]]), [[0, r.cornerBuf], [1, r.silBuf]]);
  const bg1 = c.filter((x) => x.on === 'pass' && x.k === 'setBindGroup' && x.a[0] === 1).map((x) => x.a[1]);
  assert.deepEqual(bg1, [r.passSlots[0].bind, r.passSlots[0].bind, r.passSlots[1].bind, r.passSlots[1].bind]);
  // (no outline style: no silhouettes)
  r.render(frame({ ground: null, style: { faces: 'none' } }));
  assert.deepEqual(passCalls(g.since(), r), ['setPipeline(edge.lequal|false)', 'draw(4,2)']);
  // (the edges of another mesh: none drawn)
  await r.upload(scene().mesh);
  g.since();
  r.render(frame({ ground: null, style: { faces: 'none', outline: true } }));
  assert.deepEqual(passCalls(g.since(), r), []);
  assert.notEqual(r.edgesFor, r.drawn);
  void s;
});

done();
