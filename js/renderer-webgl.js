// WebGL2 and WebGL1 backend. One GLSL ES 1.00 shader set serves both (it is
// valid in a WebGL2 context); the versions differ only in how 32-bit indices
// are drawn: WebGL2 natively, WebGL1 via OES_element_index_uint, and a WebGL1
// without that extension gets a de-indexed (expanded) vertex stream.

// Everything in model units (mm; a rack is ~1000, a big assembly can pass
// 65504, fp16's max) is computed HERE, where highp is guaranteed: the clip
// distance and the unit view direction. The fragment shader -- mediump-only on
// some GPUs -- then sees only small, well-conditioned values. (uClipV / uEyeV
// are separate from any fragment uniform: GLSL ES 1.00 refuses to link a
// uniform declared in both stages with different precision.)
const VS = `
attribute vec3 aPos;
attribute vec4 aNrm;
attribute vec4 aCol;
attribute vec4 aId;
uniform mat4 uViewProj;
uniform vec4 uClipV;    // plane: dot(xyz,p) > w is cut away
uniform vec4 uEyeV;
varying float vClip;
varying vec3 vView;
varying vec3 vNrm;
varying vec3 vCol;
varying vec4 vId;
void main() {
  vClip = dot(uClipV.xyz, aPos) - uClipV.w;
  vView = normalize(uEyeV.xyz - aPos * uEyeV.w); // w = 0: ortho view direction
  vNrm = aNrm.xyz;
  vCol = aCol.rgb;
  vId = aId;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FS_COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uState;
uniform vec4 uParams;   // x stateW, y stateH, z clip on, w unused
uniform vec4 uLight;
uniform vec4 uUp;       // world up axis: the sky and fill directions
uniform vec4 uHi;
varying float vClip;
varying vec3 vView;
varying vec3 vNrm;
varying vec3 vCol;
varying vec4 vId;
// The state texel for a body id, from the id's BYTES. Never forms the full id
// as one float: a GPU without highp in fragment shaders (mediump: exact
// integers only to 2048) would round ids above 2048 to a neighbour's texel.
// The texture is 1024 wide, so x = byte0 + 256 * (byte1 mod 4) < 1024 and
// y = floor(byte1 / 4) + 64 * byte2, each small and exact.
vec4 stateOf() {
  vec4 b = floor(vId * 255.0 + 0.5);
  float x = b.x + 256.0 * mod(b.y, 4.0);
  float y = floor(b.y / 4.0) + 64.0 * b.z;
  return texture2D(uState, vec2((x + 0.5) / uParams.x, (y + 0.5) / uParams.y));
}
bool clipped() {
  return uParams.z > 0.5 && vClip > 0.0;
}`;

const FS_SHADE = FS_COMMON + `
void main() {
  if (clipped()) discard;
  vec4 st = stateOf();
  if (st.g > 0.5) discard;
  vec3 v = normalize(vView);
  // a zero normal (degenerate or isolated vertex) would normalize to NaN
  vec3 n = dot(vNrm, vNrm) > 1e-12 ? normalize(vNrm) : v;
  if (!gl_FrontFacing) n = -n;
  if (dot(n, v) < 0.0) n = -n;
  vec3 l = normalize(uLight.xyz);
  vec3 up = uUp.xyz;
  float hemi = 0.5 + 0.5 * dot(n, up);
  float dif = max(dot(n, l), 0.0);
  // fill: from the side opposite the key light, a little above the horizon
  float fill = max(dot(n, normalize(-(l - dot(l, up) * up) + 0.3 * up)), 0.0);
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), 48.0);
  vec3 c = vCol * (0.28 + 0.17 * hemi + 0.62 * dif + 0.18 * fill) + vec3(0.18 * spec);
  if (st.r > 0.5) c = mix(c, uHi.rgb, 0.55);
  if (st.b > 0.5) c = c + vec3(0.12);
  gl_FragColor = vec4(c, 1.0);
}`;

const FS_PICK = FS_COMMON + `
void main() {
  if (clipped()) discard;
  if (stateOf().g > 0.5) discard;
  gl_FragColor = vId;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  ['aPos', 'aNrm', 'aCol', 'aId'].forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  for (const n of ['uViewProj', 'uState', 'uParams', 'uClipV', 'uEyeV', 'uLight', 'uUp', 'uHi']) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

export class WebGLRenderer {
  // version: 2 or 1. Throws if that context cannot be made.
  static create(canvas, version) {
    const attrs = { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    const gl = version === 2 ? canvas.getContext('webgl2', attrs)
      : (canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs));
    if (!gl) throw new Error(`WebGL${version} context unavailable`);
    return new WebGLRenderer(canvas, gl, version);
  }

  constructor(canvas, gl, version) {
    this.canvas = canvas;
    this.gl = gl;
    this.version = version;
    this.name = version === 2 ? 'webgl2' : 'webgl1';
    this.uintIndex = version === 2 || !!gl.getExtension('OES_element_index_uint');
    this.shade = program(gl, FS_SHADE);
    this.pickProg = program(gl, FS_PICK);
    this.buffers = [];
    this.stateTex = gl.createTexture();
    this.stateW = 1;
    this.stateH = 1;
    this.setState(new Uint8Array(4), 1, 1);
    this.pickFbo = null;
    this.pickSize = [0, 0];
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.adapterInfo = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.detail = this.uintIndex ? 'uint32 indices' : 'no uint32 indices: de-indexed stream';
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    // the pick target is a canvas-sized TEXTURE, so its limit applies too
    this.maxCanvasSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), vp[0], vp[1]);
    // On a GPU without highp in fragment shaders the state ROW coordinate
    // y + 0.5 is fp16: from y = 1024 the spacing is 1.0 and the half lands on
    // a texel edge, so only H <= 1024 rows (~1M bodies) address exactly.
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    this.mediumpOnly = !hp || hp.precision === 0;
    this.maxStateHeight = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), this.mediumpOnly ? 1024 : Infinity);
    this.drawn = null; // the mesh whose buffers are live
    this.onlost = null;
    this.onerror = null;
    // A lost context takes every buffer, texture and program with it; the owner
    // rebuilds a renderer (main.js recoverRenderer) rather than this one.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.onlost) this.onlost('WebGL context lost');
    }, { once: true });
  }

  _checkAlloc(what) {
    const err = this.gl.getError();
    if (err === this.gl.OUT_OF_MEMORY) throw new Error(`GPU out of memory allocating ${what}`);
    if (err !== this.gl.NO_ERROR && !this.gl.isContextLost()) throw new Error(`WebGL error 0x${err.toString(16)} allocating ${what}`);
  }

  // async for parity with the WebGPU backend; throws when the GPU cannot hold it.
  // Builds the new buffers first and swaps them in only on success, so a model
  // that does not fit leaves the current one drawn (same contract as WebGPU).
  // Synchronous inside, so uploads and picks cannot interleave.
  async upload(mesh) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('WebGL context lost');
    // clear EVERY stale error flag (WebGL may hold several at once) so the
    // checks below see only ours
    for (let i = 0; i < 32 && gl.getError() !== gl.NO_ERROR; i++);
    let { position, normal, color, id, index } = mesh;
    if (!this.uintIndex) {
      // Expand: one vertex per index. Costs memory, keeps WebGL1-only GPUs working.
      const n = index.length;
      const p = new Float32Array(n * 3), nm = new Int16Array(n * 4), c = new Uint8Array(n * 4), d = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const v = index[i];
        p.set(position.subarray(v * 3, v * 3 + 3), i * 3);
        nm.set(normal.subarray(v * 4, v * 4 + 4), i * 4);
        c.set(color.subarray(v * 4, v * 4 + 4), i * 4);
        d.set(id.subarray(v * 4, v * 4 + 4), i * 4);
      }
      position = p; normal = nm; color = c; id = d;
    }
    const made = [];
    const mk = (target, data, what) => {
      const b = gl.createBuffer();
      made.push(b);
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      this._checkAlloc(what);
      return b;
    };
    let vb, ib;
    try {
      vb = [
        { b: mk(gl.ARRAY_BUFFER, position, 'positions'), size: 3, type: gl.FLOAT, norm: false },
        { b: mk(gl.ARRAY_BUFFER, normal, 'normals'), size: 4, type: gl.SHORT, norm: true },
        { b: mk(gl.ARRAY_BUFFER, color, 'colours'), size: 4, type: gl.UNSIGNED_BYTE, norm: true },
        { b: mk(gl.ARRAY_BUFFER, id, 'ids'), size: 4, type: gl.UNSIGNED_BYTE, norm: true },
      ];
      ib = this.uintIndex ? mk(gl.ELEMENT_ARRAY_BUFFER, index, 'indices') : null;
    } catch (e) {
      for (const b of made) gl.deleteBuffer(b);
      throw e;
    }
    for (const b of this.buffers) gl.deleteBuffer(b);
    this.buffers = made;
    this.vb = vb;
    this.ib = ib;
    this.indexed = this.uintIndex;
    this.drawCount = index.length;
    this.drawn = mesh;
  }

  // Drop the model: nothing drawn, picks answer background for no mesh.
  async clear() {
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteBuffer(b);
    this.buffers = [];
    this.vb = null;
    this.ib = null;
    this.drawCount = 0;
    this.drawn = null;
  }

  // bytes: RGBA8 per mesh id (texel id), width*height texels.
  setState(bytes, width, height) {
    const gl = this.gl;
    // stateOf() in the shader decomposes ids for exactly this width
    if (width !== 1 && width !== 1024) throw new Error(`state texture must be 1024 wide, got ${width}`);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.stateW = width;
    this.stateH = height;
  }

  // The browser may hand back a smaller drawing buffer than asked for (memory
  // or size caps). Shrink the canvas to what was actually allocated, so the
  // viewport, the pick FBO and pick coordinates all describe the same pixels.
  // main.js compares against `requested`, not the canvas size: after a shrink
  // the canvas never equals the request, which would re-allocate every frame.
  resize(w, h) {
    const gl = this.gl;
    this.requested = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    // a lost context reports a 0x0 drawing buffer: not a shrink to follow (the
    // canvas, cloned for the recovered renderer, would start at 0x0)
    if (!gl.isContextLost() && (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h)) {
      this.canvas.width = gl.drawingBufferWidth;
      this.canvas.height = gl.drawingBufferHeight;
    }
  }

  _bind(prog, frame) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    this.vb.forEach((a, i) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, a.b);
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, a.size, a.type, a.norm, 0, 0);
    });
    if (this.ib) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    const u = prog.u;
    gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
    gl.uniform1i(u.uState, 0);
    gl.uniform4f(u.uParams, this.stateW, this.stateH, frame.clip ? 1 : 0, 0);
    gl.uniform4fv(u.uClipV, frame.clip || [0, 0, 0, 0]);
    gl.uniform4f(u.uEyeV, frame.eye[0], frame.eye[1], frame.eye[2], frame.eye[3] ?? 1);
    gl.uniform4f(u.uLight, frame.light[0], frame.light[1], frame.light[2], 0);
    const up = frame.up || [0, 1, 0];
    gl.uniform4f(u.uUp, up[0], up[1], up[2], 0);
    gl.uniform4fv(u.uHi, frame.highlight);
  }

  _draw() {
    const gl = this.gl;
    if (!this.drawCount) return;
    if (this.indexed) gl.drawElements(gl.TRIANGLES, this.drawCount, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, this.drawCount);
  }

  render(frame) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(frame.background[0], frame.background[1], frame.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.vb || frame.drawModel === false) return;
    this._bind(this.shade, frame);
    this._draw();
  }

  _ensurePickFbo() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (this.pickFbo && this.pickSize[0] === w && this.pickSize[1] === h) return;
    if (this.pickFbo) {
      gl.deleteFramebuffer(this.pickFbo);
      gl.deleteTexture(this.pickTex);
      gl.deleteRenderbuffer(this.pickDepth);
    }
    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // At least 24-bit depth, like the visible frame: a 16-bit pick buffer
    // depth-fights where the screen does not, so the pick names a different
    // body than the one drawn. WebGL1 has no DEPTH_COMPONENT24 renderbuffer but
    // its DEPTH_STENCIL is 24+8 in practice.
    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    const ds = this.version === 2 ? [gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT] : [gl.DEPTH_STENCIL, gl.DEPTH_STENCIL_ATTACHMENT];
    gl.renderbufferStorage(gl.RENDERBUFFER, ds[0], w, h);
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, ds[1], gl.RENDERBUFFER, this.pickDepth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('pick framebuffer incomplete');
    }
    this.pickSize = [w, h];
  }

  // x, y in device pixels from the canvas top-left. Returns the mesh id (0 = none).
  // Resolves to the body id, 0 for background, or null when the context is lost.
  // Same contract as the WebGPU backend: resolves to { id, mesh } (mesh = the
  // model drawn for this pick), or null when the context is lost. frameFn may
  // be a function (called now) or a frame object.
  async pick(x, y, frameFn) {
    const gl = this.gl;
    if (gl.isContextLost()) return null;
    const mesh = this.drawn || null;
    if (!this.vb) return { id: 0, mesh };
    const frame = typeof frameFn === 'function' ? frameFn() : frameFn;
    x = Math.min(Math.max(0, x | 0), this.canvas.width - 1);
    y = Math.min(Math.max(0, y | 0), this.canvas.height - 1);
    this._ensurePickFbo();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const py = this.canvas.height - 1 - y;
    // id bytes must land in the target exactly: no dithering on this pass
    gl.disable(gl.DITHER);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, py, 1, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._bind(this.pickProg, frame);
    this._draw();
    const px = new Uint8Array(4);
    gl.readPixels(x, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DITHER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // a context lost during this pick leaves px all zero: that is "no answer",
    // not "background"
    if (gl.isContextLost()) return null;
    return { id: (px[0] | (px[1] << 8) | (px[2] << 16)) >>> 0, mesh };
  }

  // Resolves once every draw issued so far has finished on the GPU (a 1-pixel
  // read-back blocks until then). For ?gpubench timing.
  sync() {
    const gl = this.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return Promise.resolve();
  }

  destroy() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
