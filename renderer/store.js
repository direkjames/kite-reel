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
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const TRANSITIONS = [['dissolve', 'Dissolve'], ['flash', 'Flash']];

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
  sel: [],            // ids of the selected clips
  cut: null,          // or: id of the clip whose join with the clip before it is selected (for transitions)
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
export const isSel = id => S.sel.includes(id);
export const selection = () => S.sel.map(clipOf).filter(Boolean);
/** The selected clip, when exactly one is selected. */
export const selected = () => (S.sel.length === 1 ? clipOf(S.sel[0]) || null : null);
export const speedOf = c => c.speed || 1;
export const duration = () => S.p.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
export const snapFrame = t => Math.round(t * S.p.canvas.fps) / S.p.canvas.fps;
export const frameLen = () => 1 / S.p.canvas.fps;

/* ---------- where a picture sits ---------- */
/** The picture's size once it has been turned, before any cropping. */
function shapeOf(c, cw, ch) {
  const m = mediaOf(c.media); let mw = (m && m.width) || cw, mh = (m && m.height) || ch;
  if (c.rot % 180) [mw, mh] = [mh, mw];
  return [mw, mh];
}
/** Where the visible part of a video or photo clip sits in the frame, in project pixels. Scale 1 means the whole picture fits inside the frame. */
export function rectOf(c, cw = S.p.canvas.w, ch = S.p.canvas.h) {
  const [mw, mh] = shapeOf(c, cw, ch), cr = c.crop;
  const k = Math.min(cw / mw, ch / mh) * c.scale, w = mw * k, h = mh * k;
  const x = cw / 2 + c.x * cw - w / 2, y = ch / 2 + c.y * ch - h / 2;
  return { x: x + w * cr.l, y: y + h * cr.t, w: w * (1 - cr.l - cr.r), h: h * (1 - cr.t - cr.b) };
}
/** Sizes and centres a clip so that what is left after cropping fits inside the frame, or (fill) covers it. */
export function frameClip(c, fill) {
  const cw = S.p.canvas.w, ch = S.p.canvas.h, [mw, mh] = shapeOf(c, cw, ch), cr = c.crop, k0 = Math.min(cw / mw, ch / mh);
  const vw = mw * k0 * (1 - cr.l - cr.r), vh = mh * k0 * (1 - cr.t - cr.b);
  c.scale = fill ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
  c.x = -(cr.l - cr.r) / 2 * mw * k0 * c.scale / cw; c.y = -(cr.t - cr.b) / 2 * mh * k0 * c.scale / ch;
}
/**
 * Which part of the source picture lands on the clip's rectangle, as six numbers for the preview:
 * a point (u, v) of the rectangle shows the source at (ox + a*u + c*v, oy + b*u + d*v). Order: turn, then mirror, then crop.
 */
export function uvOf(c) {
  const cr = c.crop, rot = ((c.rot % 360) + 360) % 360;
  const f = (u, v) => {
    let dx = cr.l + u * (1 - cr.l - cr.r); const dy = cr.t + v * (1 - cr.t - cr.b);
    if (c.flip) dx = 1 - dx;
    return rot === 90 ? [dy, 1 - dx] : rot === 180 ? [1 - dx, 1 - dy] : rot === 270 ? [1 - dy, dx] : [dx, dy];
  };
  const o = f(0, 0), a = f(1, 0), b = f(0, 1);
  return [a[0] - o[0], a[1] - o[1], b[0] - o[0], b[1] - o[1], o[0], o[1]];
}
/** Turns a clip a quarter turn as you see it, taking the cropped edges round with it. */
export function turnClip(c, clockwise) {
  const cr = c.crop;
  c.rot = (((c.rot + ((clockwise ? 90 : -90) * (c.flip ? -1 : 1))) % 360) + 360) % 360;
  c.crop = clockwise ? { t: cr.l, r: cr.t, b: cr.r, l: cr.b } : { l: cr.t, b: cr.l, r: cr.b, t: cr.r };
}
export function mirrorClip(c) { c.flip = !c.flip; c.crop = { ...c.crop, l: c.crop.r, r: c.crop.l }; }

/* ---------- transitions and fades ---------- */
const touches = (a, b) => Math.abs(a - b) < frameLen() / 2;
export const prevTouching = c => S.p.clips.find(p => p.track === c.track && p.id !== c.id && touches(p.start + p.dur, c.start)) || null;
export const nextTouching = c => S.p.clips.find(n => n.track === c.track && n.id !== c.id && touches(c.start + c.dur, n.start)) || null;
/** The transition into a clip from the one before it, if there is one in effect: { type, dur, half, prev, next }. */
export function linkIn(c) {
  if (!c.trans || c.kind === 'audio') return null;
  const prev = prevTouching(c); if (!prev) return null;
  const f = S.p.canvas.fps;
  const dur = Math.max(2, Math.floor(Math.min(c.trans.dur, prev.dur, c.dur) * f / 2 + 1e-6) * 2) / f;      // a whole number of frames on each side of the cut
  return { type: c.trans.type, dur, half: dur / 2, prev, next: c };
}
export function linkOut(c) { const n = nextTouching(c); return n ? linkIn(n) : null; }
/**
 * How far a clip reaches past its own ends for cross dissolves. lead and tail are the seconds it is shown before its
 * start and after its end; pre and post are how much of that is real footage (the rest holds the first or last frame).
 */
export function reach(c) {
  const li = linkIn(c), lo = linkOut(c), sp = speedOf(c), m = c.kind === 'video' ? mediaOf(c.media) : null;
  const lead = li && li.type === 'dissolve' ? li.half : 0, tail = lo && lo.type === 'dissolve' ? lo.half : 0;
  return { li, lo, lead, tail, pre: m ? Math.min(lead, c.in / sp) : lead, post: m ? Math.min(tail, Math.max(0, (m.duration - c.in) / sp - c.dur)) : tail };
}
/**
 * How clip a gives way to clip b in a cross dissolve. A true dissolve needs a to stay solid wherever b fades in over it,
 * and to fade out by itself everywhere else. cross: a fades out. patch: the part of a to keep solid meanwhile.
 */
export function dissolveMode(a, b) {
  if (a.kind === 'text' || b.kind === 'text' || b.opacity < 0.999) return { cross: true, patch: null };
  const ra = rectOf(a), rb = rectOf(b);
  const x0 = Math.max(ra.x, rb.x), y0 = Math.max(ra.y, rb.y), x1 = Math.min(ra.x + ra.w, rb.x + rb.w), y1 = Math.min(ra.y + ra.h, rb.y + rb.h);
  if (x1 - x0 < 2 || y1 - y0 < 2) return { cross: true, patch: null };
  const inside = rb.x <= ra.x + 0.5 && rb.y <= ra.y + 0.5 && rb.x + rb.w >= ra.x + ra.w - 0.5 && rb.y + rb.h >= ra.y + ra.h - 0.5;
  return inside ? { cross: false, patch: null } : { cross: true, patch: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}
/**
 * How a picture or text clip shows at time t, or null when it is not on screen:
 * { opacity, flash (0 to 1, how far it is washed out to white), patch ({ rect, opacity } to draw solid on top), own (t is inside the clip itself) }.
 */
export function showAt(c, t) {
  const { li, lo, lead, tail } = reach(c), end = c.start + c.dur;
  if (!(t >= c.start - lead - 1e-6 && t < end + tail - 1e-6)) return null;
  let opacity = c.kind === 'text' ? 1 : c.opacity, flash = 0, patch = null;
  if (!li && c.fadeIn > 0) opacity *= clamp((t - c.start) / Math.min(c.fadeIn, c.dur), 0, 1);
  if (!lo && c.fadeOut > 0) opacity *= clamp((end - t) / Math.min(c.fadeOut, c.dur), 0, 1);
  if (li && li.type === 'flash' && t < c.start + li.half) flash = clamp(1 - (t - c.start) / li.half, 0, 1);
  if (lo && lo.type === 'flash' && t >= end - lo.half) flash = Math.max(flash, clamp(1 - (end - t) / lo.half, 0, 1));
  if (li && li.type === 'dissolve') opacity *= clamp((t - (c.start - li.half)) / li.dur, 0, 1);
  if (lo && lo.type === 'dissolve' && t >= end - lo.half) {
    const mode = dissolveMode(c, lo.next);
    if (mode.cross) { if (mode.patch) patch = { rect: mode.patch, opacity }; opacity *= 1 - clamp((t - (end - lo.half)) / lo.dur, 0, 1); }
  }
  return { opacity, flash, patch, own: t >= c.start - 1e-6 && t < end - 1e-6 };
}
/** How loud a video or sound clip is at time t, from 0 to 1, with its fades and cross dissolves. */
export function loudAt(c, t) {
  const { li, lo, pre, post } = reach(c), end = c.start + c.dur;
  let v = c.volume;
  if (!li && c.fadeIn > 0) v *= clamp((t - c.start) / Math.min(c.fadeIn, c.dur), 0, 1);
  if (!lo && c.fadeOut > 0) v *= clamp((end - t) / Math.min(c.fadeOut, c.dur), 0, 1);
  if (li && li.type === 'dissolve') v *= clamp((t - (c.start - pre)) / (pre + li.half), 0, 1);
  if (lo && lo.type === 'dissolve') v *= clamp((end + post - t) / (post + lo.half), 0, 1);
  return clamp(v, 0, 1);
}

/* ---------- history ---------- */
let history = [], hIndex = -1, saveTimer = 0;
export function resetHistory() { history = [JSON.stringify(S.p)]; hIndex = 0; S.dirty = false; emit('history'); }
/** Call after a finished change: records an undo step, marks the project unsaved, and keeps a safety copy. */
export function commit() {
  for (const c of S.p.clips) if (c.trans && !prevTouching(c)) delete c.trans;      // a transition goes when its two clips are pulled apart
  const snap = JSON.stringify(S.p);
  if (history[hIndex] !== snap) {
    history = history.slice(0, hIndex + 1); history.push(snap);
    if (history.length > 150) history.shift();
    hIndex = history.length - 1; S.dirty = true;
  }
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { api('state', { project: S.p, path: S.path }).catch(() => {}); }, 800);
  if (S.cut && !(clipOf(S.cut) && prevTouching(clipOf(S.cut)))) { S.cut = null; emit('select'); }
  emit('project'); emit('history');
}
/** Call while a change is still in progress (mid-drag): redraws without recording an undo step. */
export function touch() { emit('project'); }
function travel(i) {
  if (i < 0 || i >= history.length) return;
  hIndex = i; S.p = JSON.parse(history[i]); S.dirty = true;
  S.sel = S.sel.filter(clipOf);
  if (S.cut && !(clipOf(S.cut) && prevTouching(clipOf(S.cut)))) S.cut = null;
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { api('state', { project: S.p, path: S.path }).catch(() => {}); }, 800);
  emit('project'); emit('select'); emit('history');
}
export const undo = () => travel(hIndex - 1);
export const redo = () => travel(hIndex + 1);
export const canUndo = () => hIndex > 0;
export const canRedo = () => hIndex < history.length - 1;
/** Selects one clip (an id), several (a list of ids) or nothing (null). */
export function select(ids) {
  const next = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
  if (!S.cut && next.length === S.sel.length && next.every((id, i) => id === S.sel[i])) return;
  S.sel = next; S.cut = null; emit('select');
}
export function toggleSel(id) { select(isSel(id) ? S.sel.filter(x => x !== id) : [...S.sel, id]); }
/** Selects the join between a clip and the one before it. */
export function selectCut(id) { if (S.cut === id && !S.sel.length) return; S.sel = []; S.cut = id; emit('select'); }

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
  S.sel = S.sel.filter(clipOf);
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
  if (kind === 'video' || kind === 'image') Object.assign(base, { media: '', in: 0, speed: 1, x: 0, y: 0, scale: 1, rot: 0, flip: false, crop: { l: 0, t: 0, r: 0, b: 0 }, opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0, adj: freshAdj(), look: 'original' });
  else if (kind === 'audio') Object.assign(base, { media: '', in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 });
  else Object.assign(base, { text: 'Your text', font: 'Segoe UI', size: 0.09, color: '#ffffff', bold: true, align: 'center', outline: true, bg: false, bgColor: '#000000', x: 0, y: 0.3, fadeIn: 0, fadeOut: 0 });
  return Object.assign(base, props);
}
/** Brings a project made by an older Kite Reel up to date: anything a clip is missing gets its usual starting value. */
export function upgradeProject(p) {
  p = Object.assign(newProject(), p);
  p.clips = (p.clips || []).map(c => { const full = makeClip(c.kind, c); if (full.crop) full.crop = { l: 0, t: 0, r: 0, b: 0, ...full.crop }; return full; });
  return p;
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
  if ('in' in c) second.in = c.in + (t - c.start) * speedOf(c);
  c.fadeOut = 0; second.fadeIn = 0; delete second.trans;      // each half keeps the fade at its own outer end
  c.dur = t - c.start;
  S.p.clips.push(second);
  return second;
}
export function removeClip(id) { S.p.clips = S.p.clips.filter(c => c.id !== id); if (isSel(id)) S.sel = S.sel.filter(x => x !== id); }
/** The longest a clip may be, given the length of its source. */
export function maxDur(c) { const m = c.media ? mediaOf(c.media) : null; return m && m.kind !== 'image' ? Math.max(frameLen(), (m.duration - c.in) / speedOf(c)) : 3600; }
/**
 * Changes how fast a clip plays. It keeps showing the same stretch of its source, so it gets longer or shorter,
 * and the clips after it on the track move along with its end when they were touching it or would be covered.
 */
export function setSpeed(c, speed) {
  const old = speedOf(c); if (speed === old) return;
  const end0 = c.start + c.dur, dur = Math.max(frameLen(), snapFrame(Math.min(c.dur * old, maxDur({ ...c, speed: 1 })) / speed));
  const after = clipsOn(c.track, c.id).filter(o => o.start >= end0 - 1e-6);
  c.speed = speed; c.dur = dur;
  if (!after.length) return;
  const by = touches(after[0].start, end0) ? c.start + dur - end0 : Math.max(0, c.start + dur - after[0].start);
  after.forEach(o => { o.start = snapFrame(o.start + by); });
}

/* ---------- moving several clips, copying and pasting ---------- */
/** The shift nearest to `want` seconds that lets these clips move together without landing on other clips or before the start. */
export function groupShift(ids, want) {
  const group = ids.map(clipOf).filter(Boolean), set = new Set(ids);
  const others = S.p.clips.filter(c => !set.has(c.id));
  const fits = d => group.every(g => g.start + d >= -1e-6 && others.every(o => o.track !== g.track || g.start + d + g.dur <= o.start + 1e-6 || g.start + d >= o.start + o.dur - 1e-6));
  if (fits(want)) return want;
  let best = 0;
  const tries = [-Math.min(...group.map(g => g.start))];
  for (const g of group) for (const o of others) if (o.track === g.track) tries.push(o.start + o.dur - g.start, o.start - g.start - g.dur);
  for (const d of tries) if (fits(d) && (best === 0 || Math.abs(d - want) < Math.abs(best - want))) best = d;
  return best;
}
let clipboard = null;      // { clips, from }: copies of the copied clips, and the time the earliest one started
export const hasCopied = () => !!clipboard;
export function clearCopied() { clipboard = null; }
export function copySelection() {
  const cs = selection(); if (!cs.length) return 0;
  clipboard = { clips: JSON.parse(JSON.stringify(cs)), from: Math.min(...cs.map(c => c.start)) };
  return cs.length;
}
/**
 * Pastes the copied clips so the earliest starts at `at`, keeping their spacing. Clips that shared a track stay together:
 * on the track they came from if there is room there, else on another of the same kind, else on a new one.
 * Returns the ids of the new clips.
 */
export function pasteAt(at) {
  if (!clipboard) return [];
  const shift = Math.max(0, snapFrame(at)) - clipboard.from, made = [], groups = new Map();
  for (const c of clipboard.clips) {
    if (c.media && !mediaOf(c.media)) continue;
    if (!groups.has(c.track)) groups.set(c.track, []);
    groups.get(c.track).push(c);
  }
  for (const [from, list] of groups) {
    const kind = trackKindFor(list[0].kind);
    const room = tr => list.every(c => clipsOn(tr.id).every(o => c.start + shift + c.dur <= o.start + 1e-6 || c.start + shift >= o.start + o.dur - 1e-6));
    const tr = [trackOf(from), ...S.p.tracks].filter(t => t && t.kind === kind).find(room) || addTrack(kind);
    for (const c of list) {
      const n = JSON.parse(JSON.stringify(c));
      n.id = 'c' + uid(); n.track = tr.id; n.start = snapFrame(c.start + shift);
      S.p.clips.push(n); made.push(n.id);
    }
  }
  return made;
}
export { clamp };
