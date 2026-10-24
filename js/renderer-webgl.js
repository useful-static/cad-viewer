// WebGL2 and WebGL1 backend. One GLSL ES 1.00 shader set serves both (it is
// valid in a WebGL2 context); the versions differ only in how 32-bit indices
// are drawn: WebGL2 natively, WebGL1 via OES_element_index_uint, and a WebGL1
// without that extension gets a de-indexed (expanded) vertex stream.

const VS = `
attribute vec3 aPos;
attribute vec4 aNrm;
attribute vec4 aCol;
attribute vec4 aId;
uniform mat4 uViewProj;
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vCol;
varying vec4 vId;
void main() {
  vPos = aPos;
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
uniform vec4 uClip;     // plane: dot(xyz,p) > w is cut away
uniform vec4 uEye;
uniform vec4 uLight;
uniform vec4 uHi;
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vCol;
varying vec4 vId;
float meshId() {
  vec4 b = floor(vId * 255.0 + 0.5);
  return b.x + b.y * 256.0 + b.z * 65536.0;
}
vec4 stateOf(float id) {
  float x = mod(id, uParams.x);
  float y = floor(id / uParams.x);
  return texture2D(uState, vec2((x + 0.5) / uParams.x, (y + 0.5) / uParams.y));
}
bool clipped() {
  return uParams.z > 0.5 && dot(uClip.xyz, vPos) > uClip.w;
}`;

const FS_SHADE = FS_COMMON + `
void main() {
  if (clipped()) discard;
  vec4 st = stateOf(meshId());
  if (st.g > 0.5) discard;
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uEye.xyz - vPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 l = normalize(uLight.xyz);
  float hemi = 0.5 + 0.5 * n.y;
  float dif = max(dot(n, l), 0.0);
  float fill = max(dot(n, normalize(vec3(-l.x, 0.3, -l.z))), 0.0);
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), 48.0);
  vec3 c = vCol * (0.28 + 0.17 * hemi + 0.62 * dif + 0.18 * fill) + vec3(0.18 * spec);
  if (st.r > 0.5) c = mix(c, uHi.rgb, 0.55);
  if (st.b > 0.5) c = c + vec3(0.12);
  gl_FragColor = vec4(c, 1.0);
}`;

const FS_PICK = FS_COMMON + `
void main() {
  if (clipped()) discard;
  if (stateOf(meshId()).g > 0.5) discard;
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
  for (const n of ['uViewProj', 'uState', 'uParams', 'uClip', 'uEye', 'uLight', 'uHi']) u[n] = gl.getUniformLocation(p, n);
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
  }

  upload(mesh) {
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteBuffer(b);
    this.buffers = [];
    let { position, normal, color, id, index } = mesh;
    this.drawCount = index.length;
    this.indexed = this.uintIndex;
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
    const mk = (target, data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      this.buffers.push(b);
      return b;
    };
    this.vb = [
      { b: mk(gl.ARRAY_BUFFER, position), size: 3, type: gl.FLOAT, norm: false },
      { b: mk(gl.ARRAY_BUFFER, normal), size: 4, type: gl.SHORT, norm: true },
      { b: mk(gl.ARRAY_BUFFER, color), size: 4, type: gl.UNSIGNED_BYTE, norm: true },
      { b: mk(gl.ARRAY_BUFFER, id), size: 4, type: gl.UNSIGNED_BYTE, norm: true },
    ];
    this.ib = this.indexed ? mk(gl.ELEMENT_ARRAY_BUFFER, index) : null;
  }

  // bytes: RGBA8 per mesh id (texel id), width*height texels.
  setState(bytes, width, height) {
    const gl = this.gl;
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

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
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
    gl.uniform4fv(u.uClip, frame.clip || [0, 0, 0, 0]);
    gl.uniform4f(u.uEye, frame.eye[0], frame.eye[1], frame.eye[2], 1);
    gl.uniform4f(u.uLight, frame.light[0], frame.light[1], frame.light[2], 0);
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
    if (!this.vb) return;
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
    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    this.pickSize = [w, h];
  }

  // x, y in device pixels from the canvas top-left. Returns the mesh id (0 = none).
  async pick(x, y, frame) {
    const gl = this.gl;
    if (!this.vb) return 0;
    this._ensurePickFbo();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const py = this.canvas.height - 1 - y;
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (px[0] | (px[1] << 8) | (px[2] << 16)) >>> 0;
  }

  destroy() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
