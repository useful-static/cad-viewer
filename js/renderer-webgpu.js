// WebGPU backend: 4x MSAA shaded pass, and a 1x RGBA8 pick pass scissored to
// one pixel whose bytes are copied back as the mesh id. Same shading model,
// state texture and clip plane as the WebGL backend (renderer-webgl.js).

import { BIAS_SHEET, BIAS_SOLID, sheetsLast } from './face-order.js';

const WGSL = /* wgsl */`
struct U {
  viewProj : mat4x4f,
  eye : vec4f,
  light : vec4f,
  clip : vec4f,
  params : vec4f,   // x stateW, y stateH, z clip on
  hi : vec4f,
  up : vec4f,       // world up axis: the sky and fill directions
  px : vec4f,       // edges: x, y target px; z width px; w extra px for the hovered body
  hover : vec4f,    // the hovered body's id bytes (0 = none)
  cull : vec4f,     // x focal px, y min radius px, z on for edges, w on for faces (the paper styles)
  fill : vec4f,     // the cut fill's colour
  xp : vec4f,       // x: explode, the fraction of each body's explode direction it is moved by (0 = none)
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var stateTex : texture_2d<f32>;
// the body table, by id: [2 id] explode direction, [2 id + 1] centre, radius
@group(0) @binding(2) var<storage, read> bodies : array<vec4f>;

struct VIn {
  @location(0) pos : vec3f,
  @location(1) nrm : vec4f,
  @location(2) col : vec4f,
  @location(3) idc : vec4f,
};
struct VOut {
  @builtin(position) clipPos : vec4f,
  @location(0) wpos : vec3f,
  @location(1) nrm : vec3f,
  @location(2) col : vec3f,
  @location(3) @interpolate(flat) idc : vec4f,
  @location(4) dash : f32, // edges: px along the segment, for the hidden edges' dashes
};

@vertex fn vs(v : VIn) -> VOut {
  var o : VOut;
  // Explode: the body moved along its direction (the body table's [2 id]),
  // before the clip and the view values, so the section cuts it where it is
  let p = v.pos + xoff(v.idc);
  o.clipPos = u.viewProj * vec4f(p, 1.0);
  o.wpos = p;
  o.nrm = v.nrm.xyz;
  o.col = v.col.rgb;
  o.idc = v.idc;
  // the paper styles: a body under cull.y px (whose edges are culled) is
  // collapsed in the face and pick passes too, so it neither blanks the
  // lines behind it nor can be picked unseen
  if (u.cull.w > 0.5 && culled(v.idc)) { o.clipPos = GONE; }
  return o;
}

fn meshId(idc : vec4f) -> u32 {
  let b = vec4u(round(idc * 255.0));
  return b.x | (b.y << 8u) | (b.z << 16u);
}
// projected radius under cull.y px: radius * focal px / w, perspective and
// ortho alike; a centre behind the eye is left to the clip
fn xoff(idc : vec4f) -> vec3f {
  if (u.xp.x == 0.0) { return vec3f(0.0); }
  return u.xp.x * bodies[meshId(idc) * 2u].xyz;
}
fn culled(idc : vec4f) -> bool {
  let cr = bodies[meshId(idc) * 2u + 1u];
  let cc = u.viewProj * vec4f(cr.xyz + xoff(idc), 1.0);
  return cc.w > 0.0 && cr.w * u.cull.x < u.cull.y * cc.w;
}
fn stateOf(id : u32) -> vec4f {
  let w = u32(u.params.x);
  return textureLoad(stateTex, vec2u(id % w, id / w), 0);
}
fn clipped(p : vec3f) -> bool {
  return u.params.z > 0.5 && dot(u.clip.xyz, p) > u.clip.w;
}

@fragment fn fsShade(i : VOut, @builtin(front_facing) ff : bool) -> @location(0) vec4f {
  let st = stateOf(meshId(i.idc));
  if (clipped(i.wpos) || st.g > 0.5) { discard; }
  let v = normalize(u.eye.xyz - i.wpos * u.eye.w); // w = 0: ortho view direction
  // a zero normal (degenerate or isolated vertex) would normalize to NaN
  var n = select(v, normalize(i.nrm), dot(i.nrm, i.nrm) > 1e-12);
  if (!ff) { n = -n; }
  if (dot(n, v) < 0.0) { n = -n; }
  let l = normalize(u.light.xyz);
  let up = u.up.xyz;
  let hemi = 0.5 + 0.5 * dot(n, up);
  let dif = max(dot(n, l), 0.0);
  // fill: from the side opposite the key light, a little above the horizon
  let fill = max(dot(n, normalize(-(l - dot(l, up) * up) + 0.3 * up)), 0.0);
  let spec = pow(max(dot(n, normalize(l + v)), 0.0), 48.0);
  var c = i.col * (0.28 + 0.17 * hemi + 0.62 * dif + 0.18 * fill) + vec3f(0.18 * spec);
  // Cut faces: with a section on, a surface seen from INSIDE (its outward
  // normal facing away from the eye) is the inside of a solid showing through
  // the cut. It is shaded flat, lit as the plane would be, so a cut part reads
  // as solid instead of a hollow shell.
  if (u.params.z > 0.5 && dot(i.nrm, v) < 0.0) {
    let pn = normalize(u.clip.xyz);
    c = i.col * 0.8 * (0.35 + 0.5 * max(dot(pn, l), 0.0) + 0.15 * (0.5 + 0.5 * dot(pn, up)));
  }
  // hi.a = 1 while anything is selected: the rest is greyed and darkened, so
  // the selection stands out whatever colours the model itself uses
  if (st.r > 0.5) { c = mix(c, u.hi.rgb, 0.5) + vec3f(0.06); }
  else if (u.hi.a > 0.5) { c = mix(c, vec3f(dot(c, vec3f(0.299, 0.587, 0.114))), 0.7) * 0.55; }
  if (st.b > 0.5) { c = c + vec3f(0.12); }
  // X-ray (params.w = 0.25): premultiplied, blended one / one-minus-src-alpha
  let a = select(1.0, u.params.w, u.params.w > 0.0);
  return vec4f(c * a, a);
}

// The cut fill, as FS_FILL in renderer-webgl.js: a flat fill where a CLOSED
// body (state alpha) shows its inside through the cut
@fragment fn fsFill(i : VOut) -> @location(0) vec4f {
  let st = stateOf(meshId(i.idc));
  if (clipped(i.wpos) || st.g > 0.5 || st.a < 0.5 || u.params.z < 0.5) { discard; }
  if (dot(i.nrm, normalize(u.eye.xyz - i.wpos * u.eye.w)) >= 0.0) { discard; }
  return vec4f(u.fill.rgb, 1.0);
}

@fragment fn fsPick(i : VOut) -> @location(0) vec4f {
  if (clipped(i.wpos) || stateOf(meshId(i.idc)).g > 0.5) { discard; }
  return i.idc;
}

// Edges, as in renderer-webgl.js: one instance per edge, a quad of 4
// corners expanded in screen space, clipped to the near plane before the
// divide (reverse-Z keeps z <= w), collapsed when both ends are behind it.
// A silhouette candidate (vsSil) is kept only where its two triangles'
// normals face opposite ways from the eye, tested at the midpoint.
// Each edge pass has its own small uniforms (group 1): the colour mode, the
// dash period and the paper colours.
struct P {
  mode : vec4f,   // x: 0 face colour darkened, 1 paper by state, 2 face colour lightened; y dash period px (0 solid); z only selected / hovered bodies
  plain : vec4f,
  sel : vec4f,
  faded : vec4f,
};
@group(1) @binding(0) var<uniform> pu : P;
struct EIn {
  @location(0) corner : vec2f,
  @location(1) p0 : vec3f,
  @location(2) p1 : vec3f,
  @location(3) idc : vec4f,
  @location(4) col : vec4f,
};
struct SIn {
  @location(0) corner : vec2f,
  @location(1) p0 : vec3f,
  @location(2) p1 : vec3f,
  @location(3) idc : vec4f,
  @location(4) col : vec4f,
  @location(5) n1 : vec4f,
  @location(6) n2 : vec4f,
};
const GONE = vec4f(2.0, 2.0, 2.0, 1.0);
@vertex fn vsEdge(e : EIn) -> VOut {
  let x = xoff(e.idc);
  return edgeOut(e.corner, e.p0 + x, e.p1 + x, e.idc, e.col);
}
@vertex fn vsSil(e : SIn) -> VOut {
  let x = xoff(e.idc);
  let mv = u.eye.xyz - 0.5 * (e.p0 + e.p1 + 2.0 * x) * u.eye.w;
  if (dot(e.n1.xyz, mv) * dot(e.n2.xyz, mv) > 0.0) {
    var o : VOut;
    o.clipPos = GONE;
    o.idc = e.idc;
    return o;
  }
  return edgeOut(e.corner, e.p0 + x, e.p1 + x, e.idc, e.col);
}
fn edgeOut(corner : vec2f, p0 : vec3f, p1 : vec3f, idc : vec4f, col : vec4f) -> VOut {
  var o : VOut;
  o.wpos = mix(p0, p1, corner.x);
  o.nrm = vec3f(0.0);
  o.col = col.rgb;
  o.idc = idc;
  o.dash = 0.0;
  // a body whose projected radius is under cull.y px draws no edges (as in
  // renderer-webgl.js): radius * focal px / w, perspective and ortho alike
  if (u.cull.z > 0.5 && culled(idc)) { o.clipPos = GONE; return o; }
  let e = EIn(corner, p0, p1, idc, col);
  var c0 = u.viewProj * vec4f(e.p0, 1.0);
  var c1 = u.viewProj * vec4f(e.p1, 1.0);
  let d0 = c0.w - c0.z;
  let d1 = c1.w - c1.z;
  if (d0 < 0.0 && d1 < 0.0) { o.clipPos = GONE; return o; }
  // the world ends clipped by the same fraction, so the section test (wpos)
  // is that of the point drawn, not of an end behind the eye
  var q0 = p0;
  var q1 = p1;
  if (d0 < 0.0) { let t = d0 / (d0 - d1); c0 = mix(c0, c1, t); q0 = mix(p0, p1, t); }
  if (d1 < 0.0) { let t = d1 / (d1 - d0); c1 = mix(c1, c0, t); q1 = mix(p1, p0, t); }
  o.wpos = mix(q0, q1, corner.x);
  let hpx = u.px.xy * 0.5;
  let s0 = c0.xy / c0.w * hpx;
  let s1 = c1.xy / c1.w * hpx;
  var dir = s1 - s0;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-6);
  let nrm = vec2f(-dir.y, dir.x);
  let b = round(e.idc * 255.0);
  let w = u.px.z + select(0.0, u.px.w, all(b == u.hover));
  let c = select(c1, c0, e.corner.x < 0.5);
  // half the width across, and half past each end, so joints close
  let off = (nrm * e.corner.y + dir * (e.corner.x * 2.0 - 1.0)) * (w * 0.5) / hpx;
  o.dash = e.corner.x * len;
  o.clipPos = vec4f(c.xy + off * c.w, c.z, c.w);
  return o;
}

// The edge colour by pu.mode.x (as FS_EDGE in renderer-webgl.js)
@fragment fn fsEdge(i : VOut) -> @location(0) vec4f {
  let st = stateOf(meshId(i.idc));
  if (clipped(i.wpos) || st.g > 0.5) { discard; }
  // z on (Hidden grey's hidden pass): only the selected or hovered bodies' edges
  if (pu.mode.z > 0.5 && st.r < 0.5 && st.b < 0.5) { discard; }
  if (pu.mode.y > 0.0 && (i.dash % pu.mode.y) > 0.5 * pu.mode.y) { discard; }
  var c = i.col;
  if (pu.mode.x > 0.5 && pu.mode.x < 1.5) {
    c = select(select(pu.plain.rgb, pu.faded.rgb, u.hi.a > 0.5 && st.b < 0.5), pu.sel.rgb, st.r > 0.5);
  } else {
    if (st.r > 0.5) { c = mix(c, u.hi.rgb, 0.5) + vec3f(0.06); }
    else if (u.hi.a > 0.5) { c = mix(c, vec3f(dot(c, vec3f(0.299, 0.587, 0.114))), 0.7) * 0.55; }
    if (st.b > 0.5) { c = c + vec3f(0.12); }
    c = select(c * 0.45, mix(c, vec3f(1.0), 0.5), pu.mode.x > 1.5);
  }
  return vec4f(c, 1.0);
}
`;

const EDGE_STRIDE = 32; // p0 f32x3, p1 f32x3, id u8x4, colour u8x4
const SIL_STRIDE = 48;  // an edge instance, then two normals snorm16x4

const MSAA = 4;
const INIT_TIMEOUT_MS = 6000;
const LOST_AT_CREATION_MS = 100;
// Reverse-Z (near = 1, far = 0, compare 'greater') on a float depth buffer: a
// small part zoomed into inside a big assembly has near/far ~ 1e4+, where a
// standard 24-bit buffer z-fights the background. The projection must be
// built reversed (frame.viewProj, mat4 `reverse`), which this.reverseZ asks for.
const DEPTH_FORMAT = 'depth32float';

// requestAdapter()/requestDevice() can stay pending forever (measured: headless
// Chromium with no usable Vulkan ICD); a bound turns that into a fallback.
function bounded(p, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${INIT_TIMEOUT_MS} ms`)), INIT_TIMEOUT_MS))]);
}

export class WebGPURenderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('navigator.gpu missing (browser has no WebGPU, or page is not a secure context)');
    const adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 'requestAdapter');
    if (!adapter) throw new Error('no WebGPU adapter');
    // Ask for the adapter's whole buffer limit: upload() refuses only what the
    // GPU itself cannot hold (a self-imposed 1 GiB cap refused models it could).
    const limits = {};
    if (adapter.limits.maxBufferSize) limits.maxBufferSize = adapter.limits.maxBufferSize;
    // the largest canvas / state texture the adapter allows, not the 8192 default
    if (adapter.limits.maxTextureDimension2D) limits.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
    const device = await bounded(adapter.requestDevice({ requiredLimits: limits }), 'requestDevice');
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('canvas webgpu context unavailable');
    const r = new WebGPURenderer(canvas, adapter, device, ctx);
    // A device can come back already lost (repeated GPU-process crashes): its
    // lost promise may resolve before any onlost handler exists. Wait on
    // device.lost itself for a moment (one timer tick did not always see it)
    // and refuse the device, so the caller falls back to WebGL instead of
    // adopting a dead renderer.
    const lostEarly = await Promise.race([device.lost.then(() => true),
      new Promise((res) => setTimeout(() => res(false), LOST_AT_CREATION_MS))]);
    if (lostEarly || r.lost) throw new Error('WebGPU device was lost at creation');
    return r;
  }

  constructor(canvas, adapter, device, ctx) {
    this.canvas = canvas;
    this.device = device;
    this.ctx = ctx;
    this.name = 'webgpu';
    const info = adapter.info || {};
    this.adapterInfo = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU adapter';
    this.detail = `${MSAA}x MSAA`;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.maxCanvasSize = device.limits.maxTextureDimension2D;
    this.maxStateHeight = device.limits.maxTextureDimension2D;
    this.reverseZ = true; // frame.viewProj must map near -> 1, far -> 0
    this.onlost = null;
    this.onerror = null;
    this.lost = false;
    this.chain = Promise.resolve();
    this.drawn = null; // the mesh whose buffers are live
    device.lost.then((e) => {
      this.lost = true;
      console.warn('WebGPU device lost:', e.message);
      if (e.reason !== 'destroyed' && this.onlost) this.onlost(e.message || 'device lost');
    });
    // Anything not caught by an error scope still has to surface, not blank the view.
    device.addEventListener('uncapturederror', (ev) => {
      console.error('WebGPU error:', ev.error.message);
      if (this.onerror) this.onerror(ev.error.message);
    });

    const mod = device.createShaderModule({ code: WGSL });
    const vbufs = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x4' }] },
      { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x4' }] },
      { arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'unorm8x4' }] },
    ];
    this.bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    // the body table; one empty body until a model's arrives
    this.bodyBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bodiesFor = null;
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const mk = (fs, format, samples, extra = {}, target = {}) => device.createRenderPipeline({
      layout,
      vertex: { module: mod, entryPoint: 'vs', buffers: vbufs },
      fragment: { module: mod, entryPoint: fs, targets: [{ format, ...target }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater', ...extra },
      multisample: { count: samples },
    });
    // The faces are always pushed back a little, so their own boundary edges
    // win the depth test along them: NEGATIVE, since reverse-Z puts far at 0.
    // The pick pass has the same bias, so it sees the shaded pass's depths.
    // Two of each face pipeline: the solids', and the sheets' with less bias,
    // so a sheet lying on a solid's face shows (face-order.js; this float
    // depth's unit is finer than WebGL's, hence the units doubled).
    const blendOver = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const facePipes = ([slope, units]) => {
      const bias = { depthBias: -2 * units, depthBiasSlopeScale: -slope };
      return {
        shade: mk('fsShade', this.format, MSAA, bias),
        pick: mk('fsPick', 'rgba8unorm', 1, bias),
        // the hidden-line styles' depth-only faces, and X-ray's blended ones
        depth: mk('fsShade', this.format, MSAA, bias, { writeMask: 0 }),
        xray: mk('fsShade', this.format, MSAA, { ...bias, depthWriteEnabled: false }, { blend: blendOver }),
        // the cut fill: the same bias, so its depths equal the depth-only pass's
        fill: mk('fsFill', this.format, MSAA, { ...bias, depthWriteEnabled: false, depthCompare: 'greater-equal' }),
      };
    };
    // made again if the biases change (the tests' controls set them in the
    // page; the pipelines fix a bias when made)
    this.facePipes = () => {
      const key = `${BIAS_SOLID}|${BIAS_SHEET}`;
      if (key !== this.biasKey) {
        this.solidPipes = facePipes(BIAS_SOLID);
        this.sheetPipes = facePipes(BIAS_SHEET);
        this.biasKey = key;
      }
    };
    this.facePipes();
    // Edge passes: their own uniforms in group 1, one buffer per pass slot
    this.passBgl = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const edgeLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl, this.passBgl] });
    this.passSlots = [0, 1, 2, 3].map(() => {
      const buf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return { buf, bind: device.createBindGroup({ layout: this.passBgl, entries: [{ binding: 0, resource: { buffer: buf } }] }) };
    });
    const inst = [{ shaderLocation: 1, offset: 0, format: 'float32x3' }, { shaderLocation: 2, offset: 12, format: 'float32x3' },
      { shaderLocation: 3, offset: 24, format: 'unorm8x4' }, { shaderLocation: 4, offset: 28, format: 'unorm8x4' }];
    const silInst = [...inst, { shaderLocation: 5, offset: 32, format: 'snorm16x4' }, { shaderLocation: 6, offset: 40, format: 'snorm16x4' }];
    // one pipeline per (depth test, boundary or silhouette), made when first used
    this.edgePipes = new Map();
    this.edgePipe = (depth, sil) => {
      const key = `${depth}|${sil}`;
      if (!this.edgePipes.has(key)) {
        this.edgePipes.set(key, device.createRenderPipeline({
          layout: edgeLayout,
          vertex: {
            module: mod, entryPoint: sil ? 'vsSil' : 'vsEdge', buffers: [
              { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
              { arrayStride: sil ? SIL_STRIDE : EDGE_STRIDE, stepMode: 'instance', attributes: sil ? silInst : inst },
            ],
          },
          fragment: { module: mod, entryPoint: 'fsEdge', targets: [{ format: this.format }] },
          primitive: { topology: 'triangle-strip', cullMode: 'none' },
          // reverse-Z: a visible edge is >= the face, a hidden one is behind it (less)
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: { lequal: 'greater-equal', greater: 'less', always: 'always' }[depth] },
          multisample: { count: MSAA },
        }));
      }
      return this.edgePipes.get(key);
    };
    this.canDrawEdges = true;
    this.silBuf = null;
    this.silCount = 0;
    this.cornerBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.cornerBuf, 0, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));
    this.edgeBuf = null;
    this.edgeCount = 0;
    this.edgesFor = null; // the mesh the edge instances were built for
    this.ubo = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.readBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.size = [0, 0];
    this.setState(new Uint8Array(4), 1, 1);
  }

  // Uploads and picks share ONE queue and run one at a time in call order: two
  // overlapping uploads used to pop each other's error scopes and leave the
  // last finisher's buffers live, and a pick during an upload saw no model.
  _enqueue(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // Builds the new buffers first and swaps them in only on success: a model the
  // device cannot hold (over maxBufferSize, or out of memory) rejects and the
  // current model stays drawn. Without the error scopes an invalid buffer
  // would silently draw nothing.
  upload(mesh) {
    return this._enqueue(() => this._upload(mesh));
  }

  async _upload(mesh) {
    const d = this.device;
    if (this.lost) throw new Error('GPU device lost');
    const max = d.limits.maxBufferSize;
    for (const [name, a] of Object.entries({ position: mesh.position, normal: mesh.normal, color: mesh.color, id: mesh.id, index: mesh.index })) {
      if (a.byteLength > max) throw new Error(`${name} data is ${(a.byteLength / 2 ** 20).toFixed(0)} MiB, over this GPU's ${(max / 2 ** 20).toFixed(0)} MiB buffer limit`);
    }
    // solids first, then sheets: drawn with different biases (face-order.js)
    const order = sheetsLast(mesh.index, mesh.header && mesh.header.meshes);
    d.pushErrorScope('out-of-memory');
    d.pushErrorScope('validation');
    const made = []; // every buffer created, so a throw part-way frees them all
    const mk = (data, usage) => {
      // plain arithmetic: `(n + 3) & ~3` is 32-bit and wraps at 2 GiB
      const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
      const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      made.push(b); // tracked before the copy, so a failed copy still frees it
      new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      b.unmap();
    };
    let err = null;
    try {
      for (const a of [mesh.position, mesh.normal, mesh.color, mesh.id]) mk(a, GPUBufferUsage.VERTEX);
      mk(order.index, GPUBufferUsage.INDEX);
    } catch (e) {
      err = e;
    }
    const [v, o] = await Promise.all([d.popErrorScope(), d.popErrorScope()]);
    const gpuErr = err || v || o || (this.lost ? new Error('GPU device lost during upload') : null);
    if (gpuErr) {
      for (const b of made) b.destroy();
      throw new Error(`GPU could not hold the model: ${gpuErr.message}`);
    }
    const old = [...(this.vbs || []), ...(this.ib ? [this.ib] : [])];
    this.vbs = made.slice(0, 4);
    this.ib = made[4];
    this.drawCount = mesh.index.length;
    this.split = order.split;
    this.drawn = mesh;
    for (const b of old) b.destroy();
  }

  setState(bytes, width, height) {
    if (this.stateTex) this.stateTex.destroy();
    this.stateTex = this.device.createTexture({
      size: [width, height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: this.stateTex }, bytes, { bytesPerRow: width * 4 }, [width, height]);
    this.stateW = width;
    this.stateH = height;
    this._rebind();
  }

  _rebind() {
    this.bind = this.device.createBindGroup({
      layout: this.bgl,
      entries: [{ binding: 0, resource: { buffer: this.ubo } }, { binding: 1, resource: this.stateTex.createView() },
        { binding: 2, resource: { buffer: this.bodyBuf } }],
    });
  }

  // The body table (js/edges.js bodyTable: 8 floats per body id) for `mesh`.
  // the body table is a storage buffer the vertex stage always reads, so
  // Explode works on every WebGPU device (renderer-webgl.js needs a texture)
  get canExplode() { return true; }

  setBodies(mesh, table) {
    if (this.lost) return;
    if (table.byteLength > this.device.limits.maxStorageBufferBindingSize) return; // no cull, rather than no model
    const b = this.device.createBuffer({ size: Math.max(64, table.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, table);
    this.bodyBuf.destroy();
    this.bodyBuf = b;
    this.bodiesFor = mesh;
    this._rebind();
  }

  resize(w, h) {
    this.requested = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
  }

  _targets() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.size[0] === w && this.size[1] === h) return;
    for (const t of [this.msaaTex, this.depthMs, this.pickTex, this.pickDepth]) if (t) t.destroy();
    const d = this.device;
    const tex = (format, samples, usage) => d.createTexture({ size: [w, h], format, sampleCount: samples, usage });
    this.msaaTex = tex(this.format, MSAA, GPUTextureUsage.RENDER_ATTACHMENT);
    this.depthMs = tex(DEPTH_FORMAT, MSAA, GPUTextureUsage.RENDER_ATTACHMENT);
    this.pickTex = tex('rgba8unorm', 1, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    this.pickDepth = tex(DEPTH_FORMAT, 1, GPUTextureUsage.RENDER_ATTACHMENT);
    this.size = [w, h];
  }

  _uniforms(frame) {
    const f = new Float32Array(64);
    f.set(frame.viewProj, 0);
    f.set([frame.eye[0], frame.eye[1], frame.eye[2], frame.eye[3] ?? 1], 16);
    f.set([frame.light[0], frame.light[1], frame.light[2], 0], 20);
    f.set(frame.clip || [0, 0, 0, 0], 24);
    f.set([this.stateW, this.stateH, frame.clip ? 1 : 0, frame.style && frame.style.faces === 'xray' ? 0.25 : 0], 28);
    f.set(frame.highlight, 32);
    const up = frame.up || [0, 1, 0];
    f.set([up[0], up[1], up[2], 0], 36);
    const e = frame.edges || { widthPx: 0, hoverPx: 0 };
    f.set([this.canvas.width, this.canvas.height, e.widthPx, e.hoverPx], 40);
    const h = frame.hoverId || 0;
    f.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255], 44);
    const cull = !!(frame.edges && frame.edges.minPx && this.bodiesFor === this.drawn);
    // the faces too in the paper styles (frame.cullFaces), the same bodies as the edges
    f.set([frame.focalPx || 0, frame.edges ? frame.edges.minPx || 0 : 0, cull ? 1 : 0, cull && frame.cullFaces ? 1 : 0], 48);
    const fill = frame.fill || [0, 0, 0];
    f.set([fill[0], fill[1], fill[2], 1], 52);
    f.set([frame.explode || 0, 0, 0, 0], 56);
    this.device.queue.writeBuffer(this.ubo, 0, f);
  }

  // The edge instances (EDGE_STRIDE bytes each) for `mesh`, queued like an
  // upload; drawn only while `mesh` is the drawn model. null data drops them.
  // Rejects when the GPU cannot hold them, keeping the previous ones.
  // silData: the silhouette candidates' instances (SIL_STRIDE bytes each), or
  // null; they are drawn only in the outline styles.
  uploadEdges(mesh, data, silData = null) {
    return this._enqueue(async () => {
      const d = this.device;
      if (this.lost) return;
      const made = [];
      const mk = async (x) => {
        if (!x || !x.byteLength) return null;
        if (x.byteLength > d.limits.maxBufferSize) throw new Error('the edges are over this GPU\'s buffer limit');
        d.pushErrorScope('out-of-memory');
        d.pushErrorScope('validation');
        const b = d.createBuffer({ size: x.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
        made.push(b);
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(x));
        b.unmap();
        const [v, o] = await Promise.all([d.popErrorScope(), d.popErrorScope()]);
        if (v || o) throw new Error(`GPU could not hold the edges: ${(v || o).message}`);
        return b;
      };
      let b, s;
      try {
        b = await mk(data);
        s = await mk(silData);
      } catch (e) {
        for (const x of made) x.destroy();
        throw e;
      }
      if (this.edgeBuf) this.edgeBuf.destroy();
      if (this.silBuf) this.silBuf.destroy();
      this.edgeBuf = b;
      this.silBuf = s;
      this.edgeCount = b ? data.byteLength / EDGE_STRIDE : 0;
      this.silCount = s ? silData.byteLength / SIL_STRIDE : 0;
      this.edgesFor = b || s ? mesh : null;
    });
  }

  // kind: shade | pick | depth | xray | fill. The solids, then the sheets,
  // each with its own pipeline's bias.
  _encodeDraw(pass, kind) {
    this.facePipes();
    pass.setBindGroup(0, this.bind);
    this.vbs.forEach((b, i) => pass.setVertexBuffer(i, b));
    pass.setIndexBuffer(this.ib, 'uint32');
    const split = Math.min(this.split ?? this.drawCount, this.drawCount);
    if (split) {
      pass.setPipeline(this.solidPipes[kind]);
      pass.drawIndexed(split);
    }
    if (this.drawCount > split) {
      pass.setPipeline(this.sheetPipes[kind]);
      pass.drawIndexed(this.drawCount - split, 1, split);
    }
  }

  render(frame) {
    if (this.lost) return;
    this._targets();
    this._uniforms(frame);
    const enc = this.device.createCommandEncoder();
    const bg = frame.background;
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTex.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 }, loadOp: 'clear', storeOp: 'discard',
      }],
      depthStencilAttachment: { view: this.depthMs.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    if (this.vbs && this.drawCount && frame.drawModel !== false) {
      const edges = frame.edges && (this.edgeCount || this.silCount) && this.edgesFor === this.drawn;
      // faces: shaded, depth only (the hidden-line styles), none (Wire), or
      // blended at a quarter without depth (X-ray)
      const faces = (frame.style && frame.style.faces) || 'shade';
      if (['shade', 'depth', 'xray'].includes(faces)) this._encodeDraw(pass, faces);
      if (faces === 'depth' && frame.clip && frame.fill) this._encodeDraw(pass, 'fill');
      if (edges) {
        const passes = (frame.edgePasses || [{ depth: 'lequal', mode: 0 }]).slice(0, this.passSlots.length);
        const outline = frame.style && frame.style.outline && this.silCount;
        passes.forEach((ps, k) => {
          const c = ps.colours || {};
          const z = [0, 0, 0];
          const pf = new Float32Array([ps.mode || 0, ps.dash || 0, ps.selectedOnly ? 1 : 0, 0, ...(c.plain || z), 1, ...(c.selected || z), 1, ...(c.faded || z), 1]);
          this.device.queue.writeBuffer(this.passSlots[k].buf, 0, pf);
          const draw = (buf, count, sil) => {
            pass.setPipeline(this.edgePipe(ps.depth || 'lequal', sil));
            pass.setBindGroup(0, this.bind);
            pass.setBindGroup(1, this.passSlots[k].bind);
            pass.setVertexBuffer(0, this.cornerBuf);
            pass.setVertexBuffer(1, buf);
            pass.draw(4, count);
          };
          if (this.edgeCount) draw(this.edgeBuf, this.edgeCount, false);
          if (outline) draw(this.silBuf, this.silCount, true);
        });
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // Picks are queued, never refused: there is one read-back buffer, and a
  // refused pick used to come back as 0 -- indistinguishable from "background",
  // so a click during a pending hover cleared the selection. Resolves to the
  // body id, 0 for background, or null when the device is lost.
  // Drop the model (queued like an upload): nothing drawn afterwards.
  clear() {
    return this._enqueue(async () => {
      for (const b of this.vbs || []) b.destroy();
      if (this.ib) this.ib.destroy();
      this.vbs = null;
      this.ib = null;
      this.drawCount = 0;
      this.drawn = null;
      if (this.edgeBuf) this.edgeBuf.destroy();
      if (this.silBuf) this.silBuf.destroy();
      this.edgeBuf = null;
      this.silBuf = null;
      this.edgeCount = 0;
      this.silCount = 0;
      this.edgesFor = null;
      this.bodiesFor = null;
    });
  }

  // frameFn is called when the pick actually RUNS (it may wait behind an
  // upload), so its projection matches the canvas size at that moment.
  // Resolves to { id, mesh }: mesh is the model this pick drew, so a caller can
  // reject an answer about a model that is no longer the one shown.
  pick(x, y, frameFn) {
    return this._enqueue(async () => {
      const mesh = this.drawn || null;
      const id = await this._pick(x, y, frameFn);
      return id === null ? null : { id, mesh };
    });
  }

  async _pick(x, y, frameFn) {
    if (this.lost) return null;
    if (!this.vbs || !this.drawCount) return 0;
    const frame = typeof frameFn === 'function' ? frameFn() : frameFn;
    try {
      this._targets();
      x = Math.min(Math.max(0, x | 0), this.size[0] - 1);
      y = Math.min(Math.max(0, y | 0), this.size[1] - 1);
      this._uniforms(frame);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.pickTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.pickDepth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setScissorRect(x, y, 1, 1);
      this._encodeDraw(pass, 'pick');
      pass.end();
      enc.copyTextureToBuffer({ texture: this.pickTex, origin: [x, y] }, { buffer: this.readBuf, bytesPerRow: 256 }, [1, 1]);
      this.device.queue.submit([enc.finish()]);
      await this.readBuf.mapAsync(GPUMapMode.READ);
      const b = new Uint8Array(this.readBuf.getMappedRange().slice(0, 4));
      this.readBuf.unmap();
      return (b[0] | (b[1] << 8) | (b[2] << 16)) >>> 0;
    } catch (e) {
      if (this.lost) return null; // mapAsync rejects when the device goes away mid-pick
      throw e;
    }
  }

  // Resolves once every submitted frame has finished on the GPU. For ?gpubench.
  sync() {
    return this.lost ? Promise.resolve() : this.device.queue.onSubmittedWorkDone();
  }

  destroy() {
    this.device.destroy();
  }
}
