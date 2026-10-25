// WebGPU backend: 4x MSAA shaded pass, and a 1x RGBA8 pick pass scissored to
// one pixel whose bytes are copied back as the mesh id. Same shading model,
// state texture and clip plane as the WebGL backend (renderer-webgl.js).

const WGSL = /* wgsl */`
struct U {
  viewProj : mat4x4f,
  eye : vec4f,
  light : vec4f,
  clip : vec4f,
  params : vec4f,   // x stateW, y stateH, z clip on
  hi : vec4f,
  up : vec4f,       // world up axis: the sky and fill directions
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var stateTex : texture_2d<f32>;

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
};

@vertex fn vs(v : VIn) -> VOut {
  var o : VOut;
  o.clipPos = u.viewProj * vec4f(v.pos, 1.0);
  o.wpos = v.pos;
  o.nrm = v.nrm.xyz;
  o.col = v.col.rgb;
  o.idc = v.idc;
  return o;
}

fn meshId(idc : vec4f) -> u32 {
  let b = vec4u(round(idc * 255.0));
  return b.x | (b.y << 8u) | (b.z << 16u);
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
  return vec4f(c, 1.0);
}

@fragment fn fsPick(i : VOut) -> @location(0) vec4f {
  if (clipped(i.wpos) || stateOf(meshId(i.idc)).g > 0.5) { discard; }
  return i.idc;
}
`;

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
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const mk = (fs, format, samples) => device.createRenderPipeline({
      layout,
      vertex: { module: mod, entryPoint: 'vs', buffers: vbufs },
      fragment: { module: mod, entryPoint: fs, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    });
    this.shadePipe = mk('fsShade', this.format, MSAA);
    this.pickPipe = mk('fsPick', 'rgba8unorm', 1);
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
      mk(mesh.index, GPUBufferUsage.INDEX);
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
    this.bind = this.device.createBindGroup({
      layout: this.bgl,
      entries: [{ binding: 0, resource: { buffer: this.ubo } }, { binding: 1, resource: this.stateTex.createView() }],
    });
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
    f.set([this.stateW, this.stateH, frame.clip ? 1 : 0, 0], 28);
    f.set(frame.highlight, 32);
    const up = frame.up || [0, 1, 0];
    f.set([up[0], up[1], up[2], 0], 36);
    this.device.queue.writeBuffer(this.ubo, 0, f);
  }

  _encodeDraw(pass, pipe) {
    pass.setPipeline(pipe);
    pass.setBindGroup(0, this.bind);
    this.vbs.forEach((b, i) => pass.setVertexBuffer(i, b));
    pass.setIndexBuffer(this.ib, 'uint32');
    pass.drawIndexed(this.drawCount);
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
    if (this.vbs && this.drawCount && frame.drawModel !== false) this._encodeDraw(pass, this.shadePipe);
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
      this._encodeDraw(pass, this.pickPipe);
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
