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
  var n = normalize(i.nrm);
  if (!ff) { n = -n; }
  let v = normalize(u.eye.xyz - i.wpos);
  if (dot(n, v) < 0.0) { n = -n; }
  let l = normalize(u.light.xyz);
  let hemi = 0.5 + 0.5 * n.y;
  let dif = max(dot(n, l), 0.0);
  let fill = max(dot(n, normalize(vec3f(-l.x, 0.3, -l.z))), 0.0);
  let spec = pow(max(dot(n, normalize(l + v)), 0.0), 48.0);
  var c = i.col * (0.28 + 0.17 * hemi + 0.62 * dif + 0.18 * fill) + vec3f(0.18 * spec);
  if (st.r > 0.5) { c = mix(c, u.hi.rgb, 0.55); }
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
    const need = 1024 * 1024 * 1024;
    const limits = {};
    for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize']) {
      if (adapter.limits[k]) limits[k] = Math.min(adapter.limits[k], need);
    }
    const device = await bounded(adapter.requestDevice({ requiredLimits: limits }), 'requestDevice');
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('canvas webgpu context unavailable');
    const r = new WebGPURenderer(canvas, adapter, device, ctx);
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
    this.lost = false;
    device.lost.then((e) => { this.lost = true; console.warn('WebGPU device lost:', e.message); });

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
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: samples },
    });
    this.shadePipe = mk('fsShade', this.format, MSAA);
    this.pickPipe = mk('fsPick', 'rgba8unorm', 1);
    this.ubo = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.readBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.size = [0, 0];
    this.setState(new Uint8Array(4), 1, 1);
  }

  upload(mesh) {
    const d = this.device;
    for (const b of this.vbs || []) b.destroy();
    if (this.ib) this.ib.destroy();
    const mk = (data, usage) => {
      const size = (data.byteLength + 3) & ~3;
      const b = d.createBuffer({ size: Math.max(size, 4), usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      b.unmap();
      return b;
    };
    this.vbs = [mesh.position, mesh.normal, mesh.color, mesh.id].map((a) => mk(a, GPUBufferUsage.VERTEX));
    this.ib = mk(mesh.index, GPUBufferUsage.INDEX);
    this.drawCount = mesh.index.length;
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
    this.depthMs = tex('depth24plus', MSAA, GPUTextureUsage.RENDER_ATTACHMENT);
    this.pickTex = tex('rgba8unorm', 1, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    this.pickDepth = tex('depth24plus', 1, GPUTextureUsage.RENDER_ATTACHMENT);
    this.size = [w, h];
  }

  _uniforms(frame) {
    const f = new Float32Array(64);
    f.set(frame.viewProj, 0);
    f.set([frame.eye[0], frame.eye[1], frame.eye[2], 1], 16);
    f.set([frame.light[0], frame.light[1], frame.light[2], 0], 20);
    f.set(frame.clip || [0, 0, 0, 0], 24);
    f.set([this.stateW, this.stateH, frame.clip ? 1 : 0, 0], 28);
    f.set(frame.highlight, 32);
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
      depthStencilAttachment: { view: this.depthMs.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    if (this.vbs && this.drawCount) this._encodeDraw(pass, this.shadePipe);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  async pick(x, y, frame) {
    if (this.lost || !this.vbs || !this.drawCount) return 0;
    if (this.picking) return 0;
    this.picking = true;
    try {
      this._targets();
      this._uniforms(frame);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.pickTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.pickDepth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
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
    } finally {
      this.picking = false;
    }
  }

  destroy() {
    this.device.destroy();
  }
}
