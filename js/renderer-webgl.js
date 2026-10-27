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

import { BIAS_SHEET, BIAS_SOLID, sheetsLast } from './face-order.js';

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
#ifdef CULL
uniform sampler2D uBodies; // the body table, as in VS_EDGE
uniform vec4 uBodyTex;
uniform vec4 uCull;        // x focal px, y min radius px, w on (the paper styles)
#endif
void main() {
  vClip = dot(uClipV.xyz, aPos) - uClipV.w;
  vView = normalize(uEyeV.xyz - aPos * uEyeV.w); // w = 0: ortho view direction
  vNrm = aNrm.xyz;
  vCol = aCol.rgb;
  vId = aId;
  gl_Position = uViewProj * vec4(aPos, 1.0);
#ifdef CULL
  // the paper styles: a body under uCull.y px (whose edges are culled) is
  // collapsed in the face and pick passes too, so it neither blanks the lines
  // behind it nor can be picked unseen
  if (uCull.w > 0.5) {
    vec4 b = floor(aId * 255.0 + 0.5);
    float t = (b.x + 256.0 * b.y + 65536.0 * b.z) * 2.0 + 1.0;
    vec4 cr = texture2D(uBodies, vec2((mod(t, uBodyTex.x) + 0.5) / uBodyTex.x, (floor(t / uBodyTex.x) + 0.5) / uBodyTex.y));
    vec4 cc = uViewProj * vec4(cr.xyz, 1.0);
    if (cc.w > 0.0 && cr.w * uCull.x < uCull.y * cc.w) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
#endif
}`;

const FS_COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uState;
uniform vec4 uParams;   // x stateW, y stateH, z clip on, w face alpha (X-ray 0.25; 0 = 1)
uniform vec4 uLight;
uniform vec4 uUp;       // world up axis: the sky and fill directions
uniform vec4 uHi;
uniform vec4 uCapN;     // the section plane's normal (the side cut away), for the cut faces
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
  // Cut faces: with a section on, a surface seen from INSIDE (its outward
  // normal facing away from the eye) is the inside of a solid showing through
  // the cut. It is shaded flat, lit as the plane would be, so a cut part reads
  // as solid instead of a hollow shell.
  if (uParams.z > 0.5 && dot(vNrm, v) < 0.0) {
    vec3 pn = normalize(uCapN.xyz);
    c = vCol * 0.8 * (0.35 + 0.5 * max(dot(pn, l), 0.0) + 0.15 * (0.5 + 0.5 * dot(pn, up)));
  }
  // uHi.a = 1 while anything is selected: the rest is greyed and darkened, so
  // the selection stands out whatever colours the model itself uses
  if (st.r > 0.5) c = mix(c, uHi.rgb, 0.5) + vec3(0.06);
  else if (uHi.a > 0.5) c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.7) * 0.55;
  if (st.b > 0.5) c = c + vec3(0.12);
  // X-ray: premultiplied, blended one / one-minus-src-alpha
  float a = uParams.w > 0.0 ? uParams.w : 1.0;
  gl_FragColor = vec4(c * a, a);
}`;

// The cut fill (the hidden-line styles, a section on): over the depth-only
// faces, at their depth, a flat fill where a CLOSED body (state alpha) shows
// its inside through the cut (its normal facing away from the eye). An open
// sheet seen from behind is not filled.
const FS_FILL = FS_COMMON + `
uniform vec4 uFill;
void main() {
  if (clipped()) discard;
  vec4 st = stateOf();
  if (st.g > 0.5 || st.a < 0.5 || uParams.z < 0.5) discard;
  if (dot(vNrm, normalize(vView)) >= 0.0) discard;
  gl_FragColor = vec4(uFill.rgb, 1.0);
}`;

const FS_PICK = FS_COMMON + `
void main() {
  if (clipped()) discard;
  if (stateOf().g > 0.5) discard;
  gl_FragColor = vId;
}`;

// Edges: one instance per edge, a quad of 4 corners (aCorner: x picks the
// end, y the side), expanded in screen space to uPx.z device px (uPx.w more
// for the hovered body, whose id bytes are uHoverId: the state texture is
// fragment-only). The segment is clipped to the near plane before the divide
// (WebGL keeps z >= -w; uNear gives d = w * x + z * y, inside when d >= 0),
// and collapsed when both ends are behind it. A silhouette candidate (uSil.x
// on) carries its two triangles' normals and is kept only where they face
// opposite ways from the eye, tested once at the midpoint so the four
// corners agree.
const VS_EDGE = `
attribute vec2 aCorner;
attribute vec3 aP0;
attribute vec3 aP1;
attribute vec4 aEId;
attribute vec4 aECol;
attribute vec4 aN1;
attribute vec4 aN2;
uniform vec4 uSil;
varying float vDash;
uniform mat4 uViewProj;
uniform vec4 uClipV;
uniform vec4 uEyeV;
uniform vec4 uPx;
uniform vec4 uHoverId;
uniform vec4 uNear;
uniform sampler2D uBodies; // the body table: texel 2 id + 1 = centre, radius
uniform vec4 uBodyTex;     // x width, y height of the body table
uniform vec4 uCull;        // x focal px, y min radius px, z on
varying float vClip;
varying vec3 vView;
varying vec3 vNrm;
varying vec3 vCol;
varying vec4 vId;
void main() {
  vec4 b = floor(aEId * 255.0 + 0.5);
  // a body whose projected radius is under uCull.y px draws no edges: they
  // would only darken it. radius px = radius * focal px / w, in perspective
  // (w = depth) and ortho (w = 1) alike. Behind the eye: left to the clip.
  if (uCull.z > 0.5) {
    float t = (b.x + 256.0 * b.y + 65536.0 * b.z) * 2.0 + 1.0;
    vec4 cr = texture2D(uBodies, vec2((mod(t, uBodyTex.x) + 0.5) / uBodyTex.x, (floor(t / uBodyTex.x) + 0.5) / uBodyTex.y));
    vec4 cc = uViewProj * vec4(cr.xyz, 1.0);
    if (cc.w > 0.0 && cr.w * uCull.x < uCull.y * cc.w) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vClip = 0.0; vView = vec3(0.0); vNrm = vec3(0.0); vCol = vec3(0.0); vId = aEId; vDash = 0.0;
      return;
    }
  }
  if (uSil.x > 0.5) {
    vec3 mv = uEyeV.xyz - 0.5 * (aP0 + aP1) * uEyeV.w;
    if (dot(aN1.xyz, mv) * dot(aN2.xyz, mv) > 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vClip = 0.0; vView = vec3(0.0); vNrm = vec3(0.0); vCol = vec3(0.0); vId = aEId; vDash = 0.0;
      return;
    }
  }
  vec3 p = mix(aP0, aP1, aCorner.x);
  vClip = dot(uClipV.xyz, p) - uClipV.w;
  vView = normalize(uEyeV.xyz - p * uEyeV.w);
  vNrm = vec3(0.0);
  vCol = aECol.rgb;
  vId = aEId;
  vec4 c0 = uViewProj * vec4(aP0, 1.0);
  vec4 c1 = uViewProj * vec4(aP1, 1.0);
  float d0 = c0.w * uNear.x + c0.z * uNear.y;
  float d1 = c1.w * uNear.x + c1.z * uNear.y;
  vDash = 0.0;
  if (d0 < 0.0 && d1 < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (d0 < 0.0) c0 = mix(c0, c1, d0 / (d0 - d1));
  if (d1 < 0.0) c1 = mix(c1, c0, d1 / (d1 - d0));
  vec2 hpx = uPx.xy * 0.5; // ("half" is reserved in GLSL ES 1.00)
  vec2 s0 = c0.xy / c0.w * hpx;
  vec2 s1 = c1.xy / c1.w * hpx;
  vec2 dir = s1 - s0;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = uPx.z + (b == uHoverId ? uPx.w : 0.0);
  vec4 c = aCorner.x < 0.5 ? c0 : c1;
  // half the width across, and half past each end, so joints close
  vec2 off = (nrm * aCorner.y + dir * (aCorner.x * 2.0 - 1.0)) * (w * 0.5) / hpx;
  // px along the segment from the (clipped) first end, for the dashes
  vDash = aCorner.x * len;
  gl_Position = vec4(c.xy + off * c.w, c.z, c.w);
}`;

// The edge colour (uEdgeMode.x): 0 the face colour with the dark view's
// state mapping, darkened (Shaded + edges); 1 the paper colours by state
// (selected, faded while a selection exists, else plain; the hovered body
// un-faded); 2 the face colour lightened (X-ray). uEdgeMode.y: the dash
// period in px (0: solid), for the hidden edges.
const FS_EDGE = FS_COMMON + `
uniform vec4 uEdgeMode;
uniform vec4 uPaperPlain;
uniform vec4 uPaperSel;
uniform vec4 uPaperFaded;
varying float vDash;
void main() {
  if (clipped()) discard;
  vec4 st = stateOf();
  if (st.g > 0.5) discard;
  // z on (Hidden grey's hidden pass): only the selected or hovered bodies' edges
  if (uEdgeMode.z > 0.5 && st.r < 0.5 && st.b < 0.5) discard;
  if (uEdgeMode.y > 0.0 && mod(vDash, uEdgeMode.y) > 0.5 * uEdgeMode.y) discard;
  vec3 c;
  if (uEdgeMode.x > 0.5 && uEdgeMode.x < 1.5) {
    c = st.r > 0.5 ? uPaperSel.rgb : (uHi.a > 0.5 && st.b < 0.5 ? uPaperFaded.rgb : uPaperPlain.rgb);
  } else {
    c = vCol;
    if (st.r > 0.5) c = mix(c, uHi.rgb, 0.5) + vec3(0.06);
    else if (uHi.a > 0.5) c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.7) * 0.55;
    if (st.b > 0.5) c = c + vec3(0.12);
    c = uEdgeMode.x > 1.5 ? mix(c, vec3(1.0), 0.5) : c * 0.45;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

const EDGE_STRIDE = 32; // p0 f32x3, p1 f32x3, id u8x4, colour u8x4
const SIL_STRIDE = 48;  // an edge instance, then two normals snorm16x4

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

const UNIFORMS = ['uViewProj', 'uState', 'uParams', 'uClipV', 'uEyeV', 'uLight', 'uUp', 'uHi', 'uCapN', 'uPx', 'uHoverId', 'uNear',
  'uBodies', 'uBodyTex', 'uCull', 'uSil', 'uEdgeMode', 'uPaperPlain', 'uPaperSel', 'uPaperFaded', 'uFill'];
const BODY_TEX_W = 1024;

function program(gl, fs, vs = VS, attrs = ['aPos', 'aNrm', 'aCol', 'aId']) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  for (const n of UNIFORMS) u[n] = gl.getUniformLocation(p, n);
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
    // The body table, a float texture read in the vertex shader: WebGL2
    // always; WebGL1 with OES_texture_float and vertex texture units.
    // Without it nothing is culled, and the face shaders are built without
    // the cull (CULL), so they never sample a texture in the vertex stage.
    this.bodyTexOk = version === 2
      || (!!gl.getExtension('OES_texture_float') && gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0);
    const vs = this.bodyTexOk ? `#define CULL\n${VS}` : VS;
    this.shade = program(gl, FS_SHADE, vs);
    this.pickProg = program(gl, FS_PICK, vs);
    this.fillProg = program(gl, FS_FILL, vs);
    // Edges need instancing: native on WebGL2, ANGLE_instanced_arrays on
    // WebGL1. Without it (rare) no edges are drawn (canDrawEdges false).
    const ia = version === 2 ? null : gl.getExtension('ANGLE_instanced_arrays');
    this.instancing = version === 2
      ? { divisor: (i, d) => gl.vertexAttribDivisor(i, d), draw: (m, f, c, n) => gl.drawArraysInstanced(m, f, c, n) }
      : ia ? { divisor: (i, d) => ia.vertexAttribDivisorANGLE(i, d), draw: (m, f, c, n) => ia.drawArraysInstancedANGLE(m, f, c, n) } : null;
    this.edgeProg = this.instancing
      ? program(gl, FS_EDGE, VS_EDGE, ['aCorner', 'aP0', 'aP1', 'aEId', 'aECol', 'aN1', 'aN2']) : null;
    this.canDrawEdges = !!this.edgeProg;
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.edgeBuf = null;
    this.edgeCount = 0;
    this.silBuf = null;
    this.silCount = 0;
    this.edgesFor = null; // the mesh the edge instances were built for
    this.bodyTex = null;
    this.bodySize = [1, 1];
    this.bodiesFor = null;
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
    let { position, normal, color, id } = mesh;
    // solids first, then sheets: drawn with different biases (face-order.js)
    const { index, split } = sheetsLast(mesh.index, mesh.header && mesh.header.meshes);
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
    this.split = split;
    this.drawn = mesh;
  }

  // The edge instances (EDGE_STRIDE bytes each) for `mesh`; drawn only while
  // `mesh` is the drawn model. null data drops them. Throws when the GPU
  // cannot hold them, keeping the previous ones.
  // silData: the silhouette candidates' instances (SIL_STRIDE bytes each), or
  // null; they are drawn only in the outline styles.
  uploadEdges(mesh, data, silData = null) {
    const gl = this.gl;
    if (!this.canDrawEdges || gl.isContextLost()) return;
    for (let i = 0; i < 32 && gl.getError() !== gl.NO_ERROR; i++);
    const made = [];
    const mk = (d, what) => {
      if (!d || !d.byteLength) return null;
      const b = gl.createBuffer();
      made.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
      this._checkAlloc(what);
      return b;
    };
    let b, s;
    try {
      b = mk(data, 'edges');
      s = mk(silData, 'outline edges');
    } catch (e) {
      for (const x of made) gl.deleteBuffer(x);
      throw e;
    }
    if (this.edgeBuf) gl.deleteBuffer(this.edgeBuf);
    if (this.silBuf) gl.deleteBuffer(this.silBuf);
    this.edgeBuf = b;
    this.silBuf = s;
    this.edgeCount = b ? data.byteLength / EDGE_STRIDE : 0;
    this.silCount = s ? silData.byteLength / SIL_STRIDE : 0;
    this.edgesFor = b || s ? mesh : null;
  }

  // The body table (js/edges.js bodyTable: 8 floats per body id) for `mesh`.
  setBodies(mesh, table) {
    const gl = this.gl;
    if (!this.bodyTexOk || gl.isContextLost()) return;
    const texels = table.length / 4;
    const w = Math.min(BODY_TEX_W, texels);
    const h = Math.ceil(texels / w);
    const data = new Float32Array(w * h * 4);
    data.set(table);
    if (!this.bodyTex) this.bodyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bodyTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.version === 2 ? gl.RGBA32F : gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, data);
    // a float texture with the default mipmap filter is incomplete
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.bodySize = [w, h];
    this.bodiesFor = mesh;
  }

  // The edge passes (frame.edgePasses, one per depth test: { depth: 'lequal'
  // | 'greater' | 'always', mode, dash, colours }), each drawing the boundary
  // edges and, in the outline styles (frame.style.outline), the silhouettes.
  _drawEdges(frame) {
    const gl = this.gl;
    const p = this.edgeProg;
    const inst = this.instancing;
    gl.useProgram(p.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    inst.divisor(0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    const u = p.u;
    gl.uniformMatrix4fv(u.uViewProj, false, frame.viewProj);
    gl.uniform1i(u.uState, 0);
    gl.uniform4f(u.uParams, this.stateW, this.stateH, frame.clip ? 1 : 0, 0);
    gl.uniform4fv(u.uClipV, frame.clip || [0, 0, 0, 0]);
    gl.uniform4f(u.uEyeV, frame.eye[0], frame.eye[1], frame.eye[2], frame.eye[3] ?? 1);
    gl.uniform4fv(u.uHi, frame.highlight);
    const e = frame.edges;
    gl.uniform4f(u.uPx, this.canvas.width, this.canvas.height, e.widthPx, e.hoverPx);
    const h = frame.hoverId || 0;
    gl.uniform4f(u.uHoverId, h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255);
    gl.uniform4f(u.uNear, 1, 1, 0, 0); // WebGL clip space: inside while z + w >= 0
    const cull = !!(e.minPx && this.bodyTex && this.bodiesFor === this.drawn);
    if (cull) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bodyTex);
      gl.activeTexture(gl.TEXTURE0);
    }
    // with no table, the unused sampler points at the state texture, so no
    // unit is left without a texture
    gl.uniform1i(u.uBodies, cull ? 1 : 0);
    gl.uniform4f(u.uBodyTex, this.bodySize[0], this.bodySize[1], 0, 0);
    gl.uniform4f(u.uCull, frame.focalPx || 0, e.minPx || 0, cull ? 1 : 0, 0);
    gl.depthMask(false);
    const DEPTH = { lequal: gl.LEQUAL, greater: gl.GREATER, always: gl.ALWAYS };
    const col = (c) => c || [0, 0, 0];
    const bind = (buf, stride, sil) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const attr = [[1, 3, gl.FLOAT, false, 0], [2, 3, gl.FLOAT, false, 12], [3, 4, gl.UNSIGNED_BYTE, true, 24], [4, 4, gl.UNSIGNED_BYTE, true, 28]];
      if (sil) attr.push([5, 4, gl.SHORT, true, 32], [6, 4, gl.SHORT, true, 40]);
      for (const [i, n, t, norm, off] of attr) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, n, t, norm, stride, off);
        inst.divisor(i, 1);
      }
      if (!sil) for (const i of [5, 6]) { gl.disableVertexAttribArray(i); inst.divisor(i, 0); }
      gl.uniform4f(u.uSil, sil ? 1 : 0, 0, 0, 0);
    };
    const passes = frame.edgePasses || [{ depth: 'lequal', mode: 0 }];
    const outline = frame.style && frame.style.outline && this.silCount;
    for (const ps of passes) {
      gl.depthFunc(DEPTH[ps.depth] || gl.LEQUAL);
      gl.uniform4f(u.uEdgeMode, ps.mode || 0, ps.dash || 0, ps.selectedOnly ? 1 : 0, 0);
      const c = ps.colours || {};
      gl.uniform4f(u.uPaperPlain, ...col(c.plain), 1);
      gl.uniform4f(u.uPaperSel, ...col(c.selected), 1);
      gl.uniform4f(u.uPaperFaded, ...col(c.faded), 1);
      if (this.edgeCount) { bind(this.edgeBuf, EDGE_STRIDE, false); inst.draw(gl.TRIANGLE_STRIP, 0, 4, this.edgeCount); }
      if (outline) { bind(this.silBuf, SIL_STRIDE, true); inst.draw(gl.TRIANGLE_STRIP, 0, 4, this.silCount); }
    }
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    // the face passes set attributes 0-3 again, but never their divisors, and
    // never use attributes 4-6
    for (let i = 1; i <= 6; i++) inst.divisor(i, 0);
    for (const i of [4, 5, 6]) gl.disableVertexAttribArray(i);
  }

  // Drop the model: nothing drawn, picks answer background for no mesh.
  async clear() {
    const gl = this.gl;
    if (this.edgeBuf) gl.deleteBuffer(this.edgeBuf);
    if (this.silBuf) gl.deleteBuffer(this.silBuf);
    this.edgeBuf = null;
    this.silBuf = null;
    this.edgeCount = 0;
    this.silCount = 0;
    this.edgesFor = null;
    this.bodiesFor = null;
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
    // (null in the pick program, which never shades: setting a null location is a no-op)
    const cn = frame.clip || [0, 0, 1, 0];
    gl.uniform4f(u.uCapN, cn[0], cn[1], cn[2], 0);
    // the paper styles' face cull (frame.cullFaces): the edges' bodies and
    // threshold. The body table on unit 1; with none, the sampler points at
    // the state texture so no unit is left empty. (Null locations in a
    // program built without CULL: no-ops.)
    const e = frame.edges;
    const cull = !!(this.bodyTexOk && frame.cullFaces && e && e.minPx && this.bodyTex && this.bodiesFor === this.drawn);
    if (cull) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bodyTex);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform1i(u.uBodies, cull ? 1 : 0);
    gl.uniform4f(u.uBodyTex, this.bodySize[0], this.bodySize[1], 0, 0);
    gl.uniform4f(u.uCull, frame.focalPx || 0, cull ? e.minPx : 0, 0, cull ? 1 : 0);
  }

  // Every face pass is biased (POLYGON_OFFSET_FILL on): the solids, then the
  // sheets with less bias, so a sheet lying on a solid's face shows.
  _draw() {
    const gl = this.gl;
    const split = Math.min(this.split ?? this.drawCount, this.drawCount);
    for (const [first, count, bias] of [[0, split, BIAS_SOLID], [split, this.drawCount - split, BIAS_SHEET]]) {
      if (!count) continue;
      gl.polygonOffset(bias[0], bias[1]);
      if (this.indexed) gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
      else gl.drawArrays(gl.TRIANGLES, first, count);
    }
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
    const edges = frame.edges && (this.edgeCount || this.silCount) && this.edgesFor === this.drawn;
    const faces = (frame.style && frame.style.faces) || 'shade';
    // The faces are always pushed back a little, so their own boundary edges
    // win the depth test along them; always, and in the pick pass too, so a
    // frame with and without edges, and a pick, see the same face depths.
    // 'depth' (the hidden-line styles) writes their depth only; 'none' (Wire)
    // draws none; 'xray' blends them at a quarter, writing no depth.
    if (faces !== 'none') {
      gl.enable(gl.POLYGON_OFFSET_FILL); // _draw sets the offsets
      if (faces === 'depth') gl.colorMask(false, false, false, false);
      if (faces === 'xray') {
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      this._bind(this.shade, frame);
      this.gl.uniform4f(this.shade.u.uParams, this.stateW, this.stateH, frame.clip ? 1 : 0, faces === 'xray' ? 0.25 : 1);
      this._draw();
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      // the cut fill: the same bias, so its depths equal the depth-only pass's
      if (faces === 'depth' && frame.clip && frame.fill) {
        this._bind(this.fillProg, frame);
        gl.uniform4f(this.fillProg.u.uFill, frame.fill[0], frame.fill[1], frame.fill[2], 1);
        gl.depthMask(false);
        gl.depthFunc(gl.LEQUAL);
        this._draw();
        gl.depthMask(true);
        gl.depthFunc(gl.LESS);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (edges) this._drawEdges(frame);
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
    gl.enable(gl.POLYGON_OFFSET_FILL); // the shaded pass's face depths (_draw sets the offsets)
    this._draw();
    gl.disable(gl.POLYGON_OFFSET_FILL);
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
