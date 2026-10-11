// The project (what gets saved and undone) and the handful of things about the session that are not part of it.
import { api, clamp, uid } from './util.js';

export const KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation'];
export const freshAdj = () => ({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temp: 0, tint: 0, vibrance: 0, saturation: 0 });
export const isNeutral = a => KEYS.every(k => !a[k]);
export const LOOKS = [
  ['original', 'Original', {}, '#8a8f99'],
  ['lift', 'Lift', { exposure: 0.3, contrast: -8, highlights: -25, shadows: 40, whites: 12, blacks: 12, temp: 4, vibrance: 12 }, '#c9cfd8'],
  ['punch', 'Punch', { contrast: 26, highlights: -15, shadows: 15, whites: 10, blacks: -14, vibrance: 30, saturation: 5 }, '#e0503c'],
  ['golden', 'Golden', { exposure: 0.1, contrast: 10, highlights: -20, shadows: 18, temp: 28, tint: 6, vibrance: 18 }, '#e2a53c'],
  ['breeze', 'Breeze', { contrast: 8, highlights: -10, whites: 8, temp: -22, tint: -3, vibrance: 14 }, '#5fa8e0'],
  ['film', 'Film', { contrast: -10, highlights: -15, whites: -10, blacks: 24, temp: 8, saturation: -12 }, '#a89a84'],
  ['dusk', 'Dusk', { exposure: -0.3, contrast: 18, highlights: -35, shadows: -10, blacks: 14, temp: -8, saturation: -18 }, '#4a5670'],
  ['mono', 'Mono', { contrast: 14, blacks: -8, saturation: -100 }, '#6e6e6e'],
  ['ink', 'Ink', { contrast: 40, highlights: -10, shadows: -22, whites: 10, blacks: -20, saturation: -100 }, '#262626'],
].map(([id, name, v, chip]) => ({ id, name, adj: Object.assign(freshAdj(), v), chip }));
export const CANVASES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

export function newProject() {
  return {
    v: 1,
    canvas: { shape: '16:9', w: 1920, h: 1080, fps: 30, auto: true },      // auto: take the shape of the first video added
    media: [],        // { id, path, name, kind, duration, width, height, fps, hasAudio, mono }
    tracks: [         // listed top to bottom; a track higher in the list is drawn in front
      { id: 't1', kind: 'text', name: 'Text 1', hidden: false, muted: false },
      { id: 'v1', kind: 'video', name: 'Video 1', hidden: false, muted: false },
      { id: 'a1', kind: 'audio', name: 'Audio 1', hidden: false, muted: false },
    ],
    clips: [],        // see makeClip
  };
}

export const S = {
  p: newProject(),
  sel: null,          // id of the selected clip
  t: 0,               // playhead, seconds
  playing: false,
  pps: 60,            // timeline zoom, pixels per second
  snap: true,
  path: '',           // where the project file lives, once saved
  dirty: false,
  rt: new Map(),      // media id -> { sid, src, thumb, wave, img, missing, proxy }: things worked out again each session
};

/* ---------- events ---------- */
const listeners = {};
export function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
export function emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); }

/* ---------- lookups ---------- */
export const mediaOf = id => S.p.media.find(m => m.id === id);
export const clipOf = id => S.p.clips.find(c => c.id === id);
export const trackOf = id => S.p.tracks.find(t => t.id === id);
export const clipsOn = (trackId, exceptId) => S.p.clips.filter(c => c.track === trackId && c.id !== exceptId).sort((a, b) => a.start - b.start);
export const selected = () => (S.sel ? clipOf(S.sel) : null);
export const duration = () => S.p.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
export const snapFrame = t => Math.round(t * S.p.canvas.fps) / S.p.canvas.fps;
export const frameLen = () => 1 / S.p.canvas.fps;
export const visualAt = (trackId, t) => S.p.clips.find(c => c.track === trackId && t >= c.start - 1e-6 && t < c.start + c.dur - 1e-6);

/** Where a video or photo clip sits in the frame, in project pixels. Scale 1 means "fits inside the frame". */
export function rectOf(c, cw = S.p.canvas.w, ch = S.p.canvas.h) {
  const m = mediaOf(c.media), mw = (m && m.width) || cw, mh = (m && m.height) || ch;
  const k = Math.min(cw / mw, ch / mh) * c.scale, w = mw * k, h = mh * k;
  return { x: cw / 2 + c.x * cw - w / 2, y: ch / 2 + c.y * ch - h / 2, w, h };
}
export function fillScale(c) {
  const m = mediaOf(c.media), cw = S.p.canvas.w, ch = S.p.canvas.h;
  if (!m || !m.width) return 1;
  return Math.max(cw / m.width, ch / m.height) / Math.min(cw / m.width, ch / m.height);
}

/* ---------- history ---------- */
let history = [], hIndex = -1, saveTimer = 0;
export function resetHistory() { history = [JSON.stringify(S.p)]; hIndex = 0; S.dirty = false; emit('history'); }
/** Call after a finished change: records an undo step, marks the project unsaved, and keeps a safety copy. */
export function commit() {
  const snap = JSON.stringify(S.p);
  if (history[hIndex] !== snap) {
    history = history.slice(0, hIndex + 1); history.push(snap);
    if (history.length > 150) history.shift();
    hIndex = history.length - 1; S.dirty = true;
  }
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { api('state', { project: S.p, path: S.path }).catch(() => {}); }, 800);
  emit('project'); emit('history');
}
/** Call while a change is still in progress (mid-drag): redraws without recording an undo step. */
export function touch() { emit('project'); }
function travel(i) {
  if (i < 0 || i >= history.length) return;
  hIndex = i; S.p = JSON.parse(history[i]); S.dirty = true;
  if (S.sel && !clipOf(S.sel)) S.sel = null;
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { api('state', { project: S.p, path: S.path }).catch(() => {}); }, 800);
  emit('project'); emit('select'); emit('history');
}
export const undo = () => travel(hIndex - 1);
export const redo = () => travel(hIndex + 1);
export const canUndo = () => hIndex > 0;
export const canRedo = () => hIndex < history.length - 1;
export function select(id) { if (S.sel === id) return; S.sel = id; emit('select'); }

/* ---------- tracks ---------- */
export function addTrack(kind) {
  const n = S.p.tracks.filter(t => t.kind === kind).length + 1;
  const tr = { id: kind[0] + uid(), kind, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`, hidden: false, muted: false };
  const tracks = S.p.tracks;
  if (kind === 'text') tracks.unshift(tr);                                   // text goes in front of everything
  else if (kind === 'audio') tracks.push(tr);
  else { const i = tracks.findIndex(t => t.kind === 'video'); tracks.splice(i < 0 ? tracks.filter(t => t.kind === 'text').length : i, 0, tr); }   // a new video track goes in front of the older ones
  return tr;
}
export function removeTrack(id) {
  S.p.clips = S.p.clips.filter(c => c.track !== id);
  S.p.tracks = S.p.tracks.filter(t => t.id !== id);
  if (S.sel && !clipOf(S.sel)) S.sel = null;
}
export const trackKindFor = clipKind => (clipKind === 'image' ? 'video' : clipKind);

/* ---------- clips ---------- */
/** Finds the spot nearest to `start` where a clip of this length fits on the track without overlapping another. */
export function freeStart(trackId, start, dur, exceptId) {
  const others = clipsOn(trackId, exceptId);
  const fits = s => s >= -1e-6 && others.every(o => s + dur <= o.start + 1e-6 || s >= o.start + o.dur - 1e-6);
  start = Math.max(0, start);
  if (fits(start)) return start;
  let best = null;
  for (const o of others) for (const s of [o.start + o.dur, o.start - dur]) {
    if (fits(s) && (best === null || Math.abs(s - start) < Math.abs(best - start))) best = s;
  }
  return best === null ? (others.length ? others[others.length - 1].start + others[others.length - 1].dur : 0) : Math.max(0, best);
}
export const trackEnd = trackId => clipsOn(trackId).reduce((m, c) => Math.max(m, c.start + c.dur), 0);

export function makeClip(kind, props) {
  const base = { id: 'c' + uid(), kind, track: '', start: 0, dur: 3 };
  if (kind === 'video' || kind === 'image') Object.assign(base, { media: '', in: 0, x: 0, y: 0, scale: 1, opacity: 1, volume: 1, adj: freshAdj(), look: 'original' });
  else if (kind === 'audio') Object.assign(base, { media: '', in: 0, volume: 1, fadeIn: 0, fadeOut: 0 });
  else Object.assign(base, { text: 'Your text', font: 'Segoe UI', size: 0.09, color: '#ffffff', bold: true, align: 'center', outline: true, bg: false, bgColor: '#000000', x: 0, y: 0.3 });
  return Object.assign(base, props);
}
/** Puts a piece of media on the timeline. Without a track or time it goes at the end of the main track of its kind. */
export function addMediaClip(mediaId, trackId, start) {
  const m = mediaOf(mediaId); if (!m) return null;
  const kind = trackKindFor(m.kind);
  let tr = trackId ? trackOf(trackId) : null;
  if (!tr || tr.kind !== kind) { const same = S.p.tracks.filter(t => t.kind === kind); tr = (kind === 'video' ? same[same.length - 1] : same[0]) || addTrack(kind); }
  const dur = m.kind === 'image' ? 4 : m.duration;
  const c = makeClip(m.kind, { media: m.id, track: tr.id, dur: snapFrame(dur) || frameLen() });
  c.start = freeStart(tr.id, snapFrame(start === undefined ? trackEnd(tr.id) : start), c.dur);
  // the first picture on an untouched project decides the frame shape
  if (S.p.canvas.auto && m.kind !== 'audio' && m.width && !S.p.clips.some(x => x.kind === 'video' || x.kind === 'image')) {
    const a = m.width / m.height;
    const shape = Object.keys(CANVASES).reduce((best, k) => (Math.abs(CANVASES[k][0] / CANVASES[k][1] - a) < Math.abs(CANVASES[best][0] / CANVASES[best][1] - a) ? k : best), '16:9');
    setCanvas(shape, true);
  }
  S.p.clips.push(c);
  return c;
}
export function addTextClip(start) {
  const tr = S.p.tracks.find(t => t.kind === 'text') || addTrack('text');
  const c = makeClip('text', { track: tr.id });
  c.start = freeStart(tr.id, snapFrame(start), c.dur);
  S.p.clips.push(c);
  return c;
}
export function setCanvas(shape, auto = false) {
  const [w, h] = CANVASES[shape];
  S.p.canvas = { ...S.p.canvas, shape, w, h, auto };
}
/** Cuts a clip in two at time t. Returns the second half, or null if t is not inside the clip. */
export function splitClip(c, t) {
  t = snapFrame(t);
  if (!(t > c.start + frameLen() / 2 && t < c.start + c.dur - frameLen() / 2)) return null;
  const second = JSON.parse(JSON.stringify(c));
  second.id = 'c' + uid(); second.start = t; second.dur = c.start + c.dur - t;
  if ('in' in c) second.in = c.in + (t - c.start);
  if (c.kind === 'audio') { c.fadeOut = 0; second.fadeIn = 0; }
  c.dur = t - c.start;
  S.p.clips.push(second);
  return second;
}
export function removeClip(id) { S.p.clips = S.p.clips.filter(c => c.id !== id); if (S.sel === id) S.sel = null; }
/** The longest a clip may be, given the length of its source. */
export function maxDur(c) { const m = c.media ? mediaOf(c.media) : null; return m && m.kind !== 'image' ? Math.max(frameLen(), m.duration - c.in) : 3600; }
export { clamp };
