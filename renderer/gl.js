// Draws the preview: stacks each layer into the frame, applying its look on the way.
// The colour maths is the same as Kite Photo's light and colour sliders, kept to changes that depend on one
// pixel at a time. That lets a whole look be written out as a colour table, which the exporter applies exactly.
import { KEYS } from './store.js';

const VERT = `
attribute vec2 aPos; varying vec2 vUv; uniform vec4 uRect;
void main(){ vUv = vec2(aPos.x * .5 + .5, .5 - aPos.y * .5); gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0., 1.); }`;
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uPlain, uOpacity, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks, uTemp, uTint, uVibrance, uSaturation;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main(){
  vec4 s = texture2D(uTex, vUv);
  if (uPlain > 0.5) { gl_FragColor = s * uOpacity; return; }
  vec3 lin = pow(s.rgb, vec3(2.2));
  vec3 wb = vec3(1.0 + 0.32 * uTemp + 0.10 * uTint, 1.0 - 0.20 * uTint, 1.0 - 0.32 * uTemp + 0.10 * uTint);
  wb /= luma(wb);
  lin *= wb * exp2(uExposure);
  if (uExposure > 0.0) {
    float t = 1.0 - 0.4 * min(uExposure, 1.0);
    vec3 over = max(lin - t, 0.0);
    lin = min(lin, vec3(t)) + (1.0 - t) * (1.0 - exp(-over / (1.0 - t)));
  }
  vec3 g = pow(max(lin, 0.0), vec3(1.0 / 2.2));
  float L = luma(g);
  float M = clamp(L, 0.0, 1.0);
  float ws = pow(1.0 - M, 3.0);
  float wh = pow(M, 3.0);
  float Ln = L;
  Ln *= 1.0 + uShadows * (uShadows > 0.0 ? 1.25 : 0.7) * ws;
  if (uHighlights < 0.0) Ln *= 1.0 + uHighlights * 0.4 * wh;
  else Ln += uHighlights * 0.6 * wh * max(1.0 - Ln, 0.0);
  Ln *= 1.0 + uWhites * 0.3 * M * M;
  g *= Ln / max(L, 1.0e-4);
  g += uBlacks * 0.16 * pow(1.0 - M, 3.0);
  if (uContrast != 0.0) {
    float k = exp(uContrast * 0.8);
    vec3 x = clamp(g, 0.0, 1.0);
    vec3 a = pow(x, vec3(k));
    vec3 b = pow(1.0 - x, vec3(k));
    g = a / (a + b);
  }
  float l2 = luma(g);
  float sat = clamp(max(g.r, max(g.g, g.b)) - min(g.r, min(g.g, g.b)), 0.0, 1.0);
  float vib = uVibrance > 0.0 ? uVibrance * (1.0 - smoothstep(0.1, 0.8, sat)) : uVibrance * 0.7;
  g = mix(vec3(l2), g, (1.0 + uSaturation) * (1.0 + vib));
  gl_FragColor = vec4(clamp(g, 0.0, 1.0), 1.0) * uOpacity;
}`;
const UNI = { exposure: 'uExposure', contrast: 'uContrast', highlights: 'uHighlights', shadows: 'uShadows', whites: 'uWhites', blacks: 'uBlacks', temp: 'uTemp', tint: 'uTint', vibrance: 'uVibrance', saturation: 'uSaturation' };
export const LUT_N = 33;

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
    let gl = canvas.getContext('webgl2', attrs);
    this.v2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', attrs);
    if (!gl) throw new Error('no-webgl');
    this.gl = gl; this.init();
  }
  init() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p; this.u = {};
    ['uTex', 'uRect', 'uPlain', 'uOpacity', ...Object.values(UNI)].forEach(n => { this.u[n] = gl.getUniformLocation(p, n); });
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.tex = new Map();
    // the identity colour table: every combination of 33 red, green and blue steps, laid out as one strip
    const N = LUT_N, data = new Uint8Array(N * N * N * 4);
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const i = (b * N * N + g * N + r) * 4;
      data[i] = Math.round(r * 255 / (N - 1)); data[i + 1] = Math.round(g * 255 / (N - 1)); data[i + 2] = Math.round(b * 255 / (N - 1)); data[i + 3] = 255;
    }
    this.table = this.make(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N * N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.fb = gl.createFramebuffer(); this.fbTex = this.make(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N * N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fbTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  make(filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return t;
  }
  has(key) { return this.tex.has(key); }
  /** Loads a video frame, photo or drawn text into the layer named `key`. `premultiply` is for pictures with see-through parts. */
  put(key, source, premultiply = false) {
    const gl = this.gl;
    let t = this.tex.get(key);
    if (!t) { t = this.make(gl.LINEAR); this.tex.set(key, t); } else gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
    catch (e) { gl.deleteTexture(t); this.tex.delete(key); return false; }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.v2) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    return true;
  }
  drop(key) { const t = this.tex.get(key); if (t) { this.gl.deleteTexture(t); this.tex.delete(key); } }
  keys() { return [...this.tex.keys()]; }
  /** Starts a frame: sizes the canvas and clears it to black. */
  begin(w, h) {
    const gl = this.gl, c = this.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.w = w; this.h = h;
  }
  paint(tex, rect, adj, opacity) {
    const gl = this.gl, u = this.u;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u.uTex, 0);
    gl.uniform4f(u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1f(u.uPlain, adj ? 0 : 1); gl.uniform1f(u.uOpacity, opacity);
    if (adj) KEYS.forEach(k => gl.uniform1f(u[UNI[k]], k === 'exposure' ? adj[k] : adj[k] / 100));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** Draws layer `key` at a rectangle given in frame pixels (of a frame fw by fh). adj null means leave colours alone. */
  layer(key, r, fw, fh, adj, opacity = 1) {
    const t = this.tex.get(key); if (!t) return;
    const cx = (r.x + r.w / 2) / fw * 2 - 1, cy = 1 - (r.y + r.h / 2) / fh * 2;
    this.paint(t, [cx, cy, r.w / fw, r.h / fh], adj, opacity);
  }
  /** A look as 33x33x33 colours: run every colour of the identity table through the sliders and note what comes out. */
  cube(adj) {
    const gl = this.gl, N = LUT_N, w = N * N, h = N;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, w, h); gl.disable(gl.BLEND);
    this.paint(this.table, [0, 0, 1, 1], adj, 1);
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Uint8Array(N * N * N * 3);
    for (let y = 0, k = 0; y < h; y++) {                    // pixels come back bottom row first
      const row = (h - 1 - y) * w * 4;
      for (let x = 0; x < w; x++) { out[k++] = raw[row + x * 4]; out[k++] = raw[row + x * 4 + 1]; out[k++] = raw[row + x * 4 + 2]; }
    }
    return out;
  }
}
