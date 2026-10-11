// Plays the project: keeps each clip's video or sound in step with the playhead and draws the stacked preview.
import { S, on, emit, clipOf, trackOf, mediaOf, duration, snapFrame, rectOf, isNeutral, select, commit, touch, selected, visualAt } from './store.js';
import { Compositor } from './gl.js';
import { drawText, textKey } from './text.js';
import { $, clamp } from './util.js';

let comp = null, canvas, frame, stage, selbox;
const view = { w: 16, h: 16, css: 1 };      // preview size in device pixels, and screen pixels per project pixel
const live = new Map();                      // clip id -> { el, src }: the player behind each video or sound clip near the playhead
const textSig = new Map();
let hits = [];                               // what is on screen right now, bottom to top: { id, r }
let raf = 0, clock = null;

export const compositor = () => comp;

/* ---------- media elements ---------- */
function playerFor(c) {
  const rt = S.rt.get(c.media);
  if (!rt || rt.missing || !rt.src) return null;
  let L = live.get(c.id);
  if (L && L.src !== rt.src) { release(c.id); L = null; }
  if (!L) {
    const el = document.createElement(c.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto'; el.playsInline = true; el.src = rt.src;
    el.addEventListener('seeked', requestRender); el.addEventListener('loadeddata', requestRender);
    L = { el, src: rt.src }; live.set(c.id, L);
  }
  return L;
}
function release(id) {
  const L = live.get(id); if (!L) return;
  try { L.el.pause(); L.el.removeAttribute('src'); L.el.load(); } catch (e) { /* already gone */ }
  live.delete(id); if (comp) comp.drop('clip:' + id);
}
function loudness(c, t) {
  let v = c.volume;
  if (c.kind === 'audio') {
    const into = t - c.start, left = c.start + c.dur - t;
    if (c.fadeIn > 0 && into < c.fadeIn) v *= clamp(into / c.fadeIn, 0, 1);
    if (c.fadeOut > 0 && left < c.fadeOut) v *= clamp(left / c.fadeOut, 0, 1);
  }
  return clamp(v, 0, 1);
}
/** Lines every nearby clip's player up with time t, and lets go of the ones that are far away. */
function sync(t) {
  const seen = new Set();
  for (const c of S.p.clips) {
    if (c.kind === 'text' || c.kind === 'image') continue;
    const active = t >= c.start - 1e-6 && t < c.start + c.dur - 1e-6;
    if (!(t >= c.start - 2 && t < c.start + c.dur + 1)) continue;
    const L = playerFor(c); if (!L) continue;
    seen.add(c.id);
    const el = L.el, tr = trackOf(c.track), m = mediaOf(c.media);
    const local = clamp(c.in + (t - c.start), c.in, c.in + c.dur);
    const vol = active && tr && !tr.muted && m && m.hasAudio ? loudness(c, t) : 0;
    el.muted = vol <= 0; el.volume = vol;
    if (active && S.playing) {
      if (el.paused) { if (Math.abs(el.currentTime - local) > 0.05) el.currentTime = local; el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - local) > 0.3) el.currentTime = local;      // drifted: pull it back
    } else {
      if (!el.paused) el.pause();
      const target = active ? local : t < c.start ? c.in : null;                     // clips about to start wait on their first frame
      if (target !== null && !el.seeking && Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
    }
  }
  for (const id of [...live.keys()]) if (!seen.has(id)) release(id);
  for (const id of [...textSig.keys()]) if (!clipOf(id)) { textSig.delete(id); comp.drop('text:' + id); }
}

/* ---------- drawing ---------- */
function render() {
  if (!comp) return;
  const cw = S.p.canvas.w, ch = S.p.canvas.h;
  comp.begin(view.w, view.h);
  hits = [];
  for (let i = S.p.tracks.length - 1; i >= 0; i--) {         // the last track is the furthest back
    const tr = S.p.tracks[i];
    if (tr.kind === 'audio' || tr.hidden) continue;
    const c = visualAt(tr.id, S.t); if (!c) continue;
    if (c.kind === 'text') {
      const d = drawText(c, cw, ch), key = 'text:' + c.id, sig = textKey(c, cw, ch);
      if (textSig.get(c.id) !== sig) { comp.put(key, d.canvas, true); textSig.set(c.id, sig); }
      comp.layer(key, d, cw, ch, null, 1);
      hits.push({ id: c.id, r: d });
    } else {
      const r = rectOf(c); let key;
      if (c.kind === 'image') {
        const rt = S.rt.get(c.media); key = 'img:' + c.media;
        if (!comp.has(key) && rt && rt.img && rt.img.complete && rt.img.naturalWidth) comp.put(key, rt.img);
      } else {
        key = 'clip:' + c.id;
        const L = live.get(c.id);
        if (L && L.el.readyState >= 2 && L.el.videoWidth) comp.put(key, L.el);
      }
      comp.layer(key, r, cw, ch, isNeutral(c.adj) ? null : c.adj, c.opacity);
      hits.push({ id: c.id, r });
    }
  }
  placeSelBox();
}
function step() { raf = 0; if (S.playing) return; sync(S.t); render(); }
export function requestRender() { if (!raf && !S.playing) raf = requestAnimationFrame(step); }
/** Draws the current frame right now and returns once it is on the canvas. Used by tests and thumbnails. */
export function renderNow() { sync(S.t); render(); }

/* ---------- transport ---------- */
function loop(now) {
  if (!S.playing) return;
  const dur = duration();
  S.t = clock.t0 + (now - clock.p0) / 1000;
  if (S.t >= dur) { S.t = dur; pause(); return; }
  sync(S.t); render(); emit('time');
  requestAnimationFrame(loop);
}
export function play() {
  const dur = duration(); if (dur <= 0 || S.playing) return;
  if (S.t >= dur - 0.02) S.t = 0;
  S.playing = true; clock = { t0: S.t, p0: performance.now() };
  emit('play'); requestAnimationFrame(loop);
}
export function pause() {
  if (!S.playing) return;
  S.playing = false; S.t = snapFrame(S.t);
  emit('play'); emit('time'); requestRender();
}
export const toggle = () => (S.playing ? pause() : play());
export function seek(t) {
  S.t = clamp(snapFrame(t), 0, duration());
  if (S.playing) clock = { t0: S.t, p0: performance.now() };
  emit('time'); requestRender();
}

/* ---------- the preview's size, and moving things in it ---------- */
function layout() {
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (aw < 8 || ah < 8) return;
  const cw = S.p.canvas.w, ch = S.p.canvas.h, k = Math.min(aw / cw, ah / ch);
  const cssW = Math.max(1, Math.round(cw * k)), cssH = Math.max(1, Math.round(ch * k));
  frame.style.width = cssW + 'px'; frame.style.height = cssH + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2), cap = Math.min(1, cw / (cssW * dpr));    // never more pixels than the project has
  view.w = Math.max(1, Math.round(cssW * dpr * cap)); view.h = Math.max(1, Math.round(cssH * dpr * cap)); view.css = cssW / cw;
}
function placeSelBox() {
  const h = S.sel ? hits.find(x => x.id === S.sel) : null;
  if (!h) { selbox.hidden = true; return; }
  selbox.hidden = false;
  selbox.style.left = h.r.x * view.css + 'px'; selbox.style.top = h.r.y * view.css + 'px';
  selbox.style.width = h.r.w * view.css + 'px'; selbox.style.height = h.r.h * view.css + 'px';
}
function wirePointer() {
  let drag = null;
  const at = e => { const b = canvas.getBoundingClientRect(); return [(e.clientX - b.left) / view.css, (e.clientY - b.top) / view.css]; };
  canvas.addEventListener('pointerdown', e => {
    const [x, y] = at(e);
    let hit = null;
    for (let i = hits.length - 1; i >= 0; i--) { const r = hits[i].r; if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit = hits[i]; break; } }
    select(hit ? hit.id : null); requestRender();
    if (!hit) return;
    const c = clipOf(hit.id);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    drag = { id: e.pointerId, c, x0: e.clientX, y0: e.clientY, ox: c.x, oy: c.y, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.x0) / view.css / S.p.canvas.w, dy = (e.clientY - drag.y0) / view.css / S.p.canvas.h;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
    drag.moved = true;
    let nx = drag.ox + dx, ny = drag.oy + dy;
    if (Math.abs(nx) < 0.012) nx = 0;                     // settles on the centre lines
    if (Math.abs(ny) < 0.012) ny = 0;
    drag.c.x = nx; drag.c.y = ny; touch();
  });
  const end = e => { if (!drag || e.pointerId !== drag.id) return; const moved = drag.moved; drag = null; if (moved) commit(); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  // the round knob resizes the selected layer about its centre
  const knob = $('#knob'); let size = null;
  knob.addEventListener('pointerdown', e => {
    const c = selected(), h = hits.find(x => x.id === S.sel); if (!c || !h) return;
    e.preventDefault(); e.stopPropagation();
    try { knob.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    const b = canvas.getBoundingClientRect(), cx = b.left + (h.r.x + h.r.w / 2) * view.css, cy = b.top + (h.r.y + h.r.h / 2) * view.css;
    size = { id: e.pointerId, c, cx, cy, d0: Math.max(4, Math.hypot(e.clientX - cx, e.clientY - cy)), v0: c.kind === 'text' ? c.size : c.scale };
  });
  knob.addEventListener('pointermove', e => {
    if (!size || e.pointerId !== size.id) return;
    const k = Math.hypot(e.clientX - size.cx, e.clientY - size.cy) / size.d0;
    if (size.c.kind === 'text') size.c.size = clamp(size.v0 * k, 0.02, 0.6); else size.c.scale = clamp(size.v0 * k, 0.05, 8);
    touch();
  });
  const endSize = e => { if (!size || e.pointerId !== size.id) return; size = null; commit(); };
  knob.addEventListener('pointerup', endSize); knob.addEventListener('pointercancel', endSize);
}

export function init() {
  canvas = $('#view'); frame = $('#frame'); stage = $('#stage'); selbox = $('#selbox');
  comp = new Compositor(canvas);
  canvas.addEventListener('webglcontextlost', e => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => { comp.init(); textSig.clear(); requestRender(); });
  new ResizeObserver(() => { layout(); requestRender(); }).observe(stage);
  on('project', () => { layout(); requestRender(); });
  on('select', requestRender);
  on('media', requestRender);
  wirePointer();
  layout(); requestRender();
}
