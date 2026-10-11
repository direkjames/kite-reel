// The multi-track timeline: tracks, clips, ruler and playhead, and everything you do to clips with the pointer.
import { S, on, clipOf, trackOf, mediaOf, clipsOn, duration, snapFrame, frameLen, select, commit, touch, selected, addTrack, removeTrack, splitClip, removeClip, freeStart, maxDur } from './store.js';
import { seek, pause } from './player.js';
import { $, $$, el, clamp, fmtShort } from './util.js';

const HEAD_W = 150, SNAP_PX = 8, MIN_DUR = 0.1;
let scroll, rows, ruler, playhead, snapline;

const ICON = {
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5l11 11M6.2 4A6 6 0 0 1 8 3.5c4 0 6.5 4.500 6.500 4.500a12 12 0 0 1-2 2.500M10 11.900A6 6 0 0 1 8 12.500C4 12.500 1.500 8 1.500 8a12 12 0 0 1 2.600-3"/></svg>',
  sound: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.500L8.500 13V3L5 6z"/><path d="M11 5.500a3.500 3.500 0 0 1 0 5"/></svg>',
  soundOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.500L8.500 13V3L5 6z"/><path d="M11 6l3 4M14 6l-3 4"/></svg>',
  remove: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.500 4.500l7 7M11.500 4.500l-7 7"/></svg>',
};
const iconButton = (svg, title, pressed) => { const b = el('button', { type: 'button', title }); b.innerHTML = svg; b.setAttribute('aria-label', title); if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed)); return b; };

const lanesWidth = () => Math.max(scroll.clientWidth - HEAD_W, (duration() + 8) * S.pps);
/** The timeline time under a point on the screen. */
const timeAt = clientX => (clientX - scroll.getBoundingClientRect().left - HEAD_W + scroll.scrollLeft) / S.pps;

/* ---------- drawing ---------- */
function clipNode(c) {
  const m = c.media ? mediaOf(c.media) : null, rt = c.media ? S.rt.get(c.media) : null;
  const d = el('div', { className: `clip k-${c.kind}${c.id === S.sel ? ' sel' : ''}${rt && rt.missing ? ' missing' : ''}` });
  d.dataset.id = c.id;
  d.style.left = c.start * S.pps + 'px'; d.style.width = Math.max(2, c.dur * S.pps - 1) + 'px';
  if ((c.kind === 'video' || c.kind === 'image') && rt && rt.thumb) d.style.backgroundImage = `url("${rt.thumb}")`;
  if (c.kind === 'audio' && rt && rt.wave && m) {
    const w = el('div', { className: 'wave' });
    w.style.webkitMaskImage = `url("${rt.wave}")`; w.style.webkitMaskSize = `${m.duration * S.pps}px 100%`; w.style.webkitMaskPosition = `${-c.in * S.pps}px 0`;
    d.append(w);
  }
  const label = c.kind === 'text' ? String(c.text).split('\n')[0] || 'Text' : rt && rt.missing ? `${m ? m.name : 'File'} (missing)` : m ? m.name : '';
  d.append(el('span', { className: 'nm', textContent: label }), el('i', { className: 'edge l' }), el('i', { className: 'edge r' }));
  return d;
}
function build() {
  const w = lanesWidth();
  $('#tl-content').style.width = HEAD_W + w + 'px';
  rows.textContent = '';
  for (const tr of S.p.tracks) {
    const off = tr.kind === 'audio' ? tr.muted : tr.hidden;
    const row = el('div', { className: `tl-row k-${tr.kind}${off ? ' off' : ''}` }); row.dataset.track = tr.id;
    const head = el('div', { className: 'tl-head' }, [el('i', { className: 'dot' }), el('span', { className: 'nm', textContent: tr.name, title: tr.name })]);
    if (tr.kind !== 'audio') { const b = iconButton(tr.hidden ? ICON.eyeOff : ICON.eye, tr.hidden ? 'Show this track' : 'Hide this track', tr.hidden); b.dataset.act = 'hide'; head.append(b); }
    if (tr.kind !== 'text') { const b = iconButton(tr.muted ? ICON.soundOff : ICON.sound, tr.muted ? 'Turn this track’s sound on' : 'Mute this track', tr.muted); b.dataset.act = 'mute'; head.append(b); }
    if (!clipsOn(tr.id).length) { const b = iconButton(ICON.remove, 'Remove this empty track'); b.dataset.act = 'remove'; head.append(b); }
    const lane = el('div', { className: 'tl-lane' });
    clipsOn(tr.id).forEach(c => lane.append(clipNode(c)));
    row.append(head, lane); rows.append(row);
  }
  drawRuler(); placePlayhead(); syncTools();
}
function drawRuler() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(1, scroll.clientWidth - HEAD_W), h = 26;
  ruler.width = Math.round(w * dpr); ruler.height = Math.round(h * dpr); ruler.style.width = w + 'px';
  const x = ruler.getContext('2d'), css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600], major = steps.find(s => s * S.pps >= 70) || 600, minor = major / 5;
  const from = scroll.scrollLeft / S.pps, to = from + w / S.pps;
  x.font = '10.5px "DM Mono", Consolas, monospace'; x.textBaseline = 'top'; x.fillStyle = col('--fg-3'); x.strokeStyle = col('--line'); x.lineWidth = 1;
  x.beginPath();
  for (let i = Math.floor(from / minor); i * minor <= to; i++) {
    const t = i * minor, px = Math.round((t - from) * S.pps) + 0.5, big = i % 5 === 0;
    x.moveTo(px, big ? 12 : 19); x.lineTo(px, h);
    if (big) x.fillText(major < 1 ? t.toFixed(1) + 's' : fmtShort(t), px + 4, 3);
  }
  x.stroke();
}
function placePlayhead() {
  const x = S.t * S.pps;
  playhead.style.left = HEAD_W + x + 'px';
  playhead.hidden = x < scroll.scrollLeft - 1;          // do not draw over the track names
}
function syncTools() {
  $('#btn-delete').disabled = !selected();
  $('#btn-split').disabled = !S.p.clips.some(c => S.t > c.start + frameLen() / 2 && S.t < c.start + c.dur - frameLen() / 2);
  $('#btn-snap').setAttribute('aria-pressed', String(S.snap));
  $('#zoom').value = Math.round(Math.log(S.pps / 8) / Math.log(50) * 100);
}

/* ---------- zoom ---------- */
export function setZoom(pps, anchorClientX) {
  const b = scroll.getBoundingClientRect(), ax = anchorClientX === undefined ? b.left + HEAD_W + (scroll.clientWidth - HEAD_W) / 2 : anchorClientX;
  const t = timeAt(ax);
  S.pps = clamp(pps, 8, 400);
  build();
  scroll.scrollLeft = Math.max(0, t * S.pps - (ax - b.left - HEAD_W));
  drawRuler(); placePlayhead();
}
/** Zooms out just enough to bring a time into view, if it is off the right-hand side. */
export function reveal(t) { if (t * S.pps > scroll.scrollLeft + scroll.clientWidth - HEAD_W - 24) zoomFit(); }
export function zoomFit() { S.pps = clamp((scroll.clientWidth - HEAD_W - 48) / Math.max(duration(), 8), 8, 400); build(); scroll.scrollLeft = 0; drawRuler(); placePlayhead(); }

/* ---------- editing ---------- */
export function splitAtPlayhead() {
  const sel = selected();
  const targets = sel && S.t > sel.start && S.t < sel.start + sel.dur ? [sel] : S.p.clips.filter(c => S.t > c.start && S.t < c.start + c.dur);
  let did = false;
  targets.forEach(c => { if (splitClip(c, S.t)) did = true; });
  if (did) commit();
}
export function deleteSelected() { const c = selected(); if (!c) return; removeClip(c.id); commit(); select(null); }

/** Times worth snapping to: the start, the playhead, and every other clip's edges. */
function snapTimes(exceptId) {
  const t = [0, S.t];
  for (const c of S.p.clips) if (c.id !== exceptId) t.push(c.start, c.start + c.dur);
  return t;
}
function snapTo(t, times) {
  if (!S.snap) return { t, hit: null };
  let best = null;
  for (const s of times) if (Math.abs(s - t) * S.pps <= SNAP_PX && (best === null || Math.abs(s - t) < Math.abs(best - t))) best = s;
  return best === null ? { t, hit: null } : { t: best, hit: best };
}
function showSnap(hit) { snapline.hidden = hit === null; if (hit !== null) snapline.style.left = HEAD_W + hit * S.pps + 'px'; }
function rowAt(clientY) { return $$('.tl-row', rows).find(r => { const b = r.getBoundingClientRect(); return clientY >= b.top && clientY < b.bottom; }) || null; }

/** For dragging media in from the library: which track and time is under the pointer. */
export function dropTarget(clientX, clientY, kind) {
  const b = scroll.getBoundingClientRect();
  $$('.tl-row.over', rows).forEach(r => r.classList.remove('over'));
  if (clientX < b.left || clientX > b.right || clientY < b.top || clientY > b.bottom) return null;
  const row = rowAt(clientY), tr = row ? trackOf(row.dataset.track) : null;
  const match = tr && tr.kind === kind ? row : $$('.tl-row.k-' + kind, rows).pop() || null;      // wrong kind of track: fall back to the main one
  if (match) match.classList.add('over');
  return { track: match ? match.dataset.track : '', time: Math.max(0, snapFrame(timeAt(clientX))) };
}
export function clearDrop() { $$('.tl-row.over', rows).forEach(r => r.classList.remove('over')); }

function wire() {
  let drag = null;
  scroll.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const head = e.target.closest('.tl-head'); if (head || e.target.closest('.tl-corner')) return;
    const sb = scroll.getBoundingClientRect();
    if (e.clientX > sb.left + scroll.clientWidth || e.clientY > sb.top + scroll.clientHeight) return;      // the scroll bars keep working as usual
    if (e.clientX < sb.left + HEAD_W) return;
    const onRuler = !!e.target.closest('.tl-ruler'), node = e.target.closest('.clip');
    e.preventDefault();
    try { scroll.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    if (node && !onRuler) {
      const c = clipOf(node.dataset.id); if (!c) return;
      select(c.id);
      const edge = e.target.closest('.edge');
      drag = { id: e.pointerId, kind: edge ? (edge.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move', c, x0: e.clientX, grab: timeAt(e.clientX) - c.start,
        o: { start: c.start, dur: c.dur, in: c.in || 0, track: c.track }, times: snapTimes(c.id), moved: false };
    } else {
      if (!onRuler) select(null);
      pause(); seek(timeAt(e.clientX));
      drag = { id: e.pointerId, kind: 'scrub' };
    }
  });
  scroll.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.kind === 'scrub') { seek(timeAt(e.clientX)); return; }
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return;
    drag.moved = true;
    const c = drag.c, o = drag.o, T = timeAt(e.clientX);
    if (drag.kind === 'move') {
      let start = T - drag.grab;
      const a = snapTo(start, drag.times), b = snapTo(start + c.dur, drag.times);
      let hit = null;
      if (a.hit !== null && (b.hit === null || Math.abs(a.t - start) <= Math.abs(b.t - (start + c.dur)))) { start = a.t; hit = a.hit; }
      else if (b.hit !== null) { start = b.t - c.dur; hit = b.hit; }
      const row = rowAt(e.clientY), tr = row ? trackOf(row.dataset.track) : null;
      if (tr && tr.kind === trackOf(o.track).kind) c.track = tr.id;                    // clips can move between tracks of their own kind
      const placed = freeStart(c.track, snapFrame(Math.max(0, start)), c.dur, c.id);
      showSnap(hit !== null && Math.abs(placed - snapFrame(Math.max(0, start))) < 1e-6 ? hit : null);
      c.start = placed;
    } else {
      const others = clipsOn(c.track, c.id), end = o.start + o.dur;
      if (drag.kind === 'trim-l') {
        const prev = others.filter(x => x.start + x.dur <= o.start + 1e-6).pop();
        const lo = Math.max(prev ? prev.start + prev.dur : 0, c.media && mediaOf(c.media) && mediaOf(c.media).kind !== 'image' ? o.start - o.in : 0);
        const s = snapTo(T, drag.times); showSnap(s.hit);
        const start = clamp(snapFrame(s.t), lo, end - MIN_DUR);
        if ('in' in c) c.in = Math.max(0, o.in + (start - o.start));
        c.start = start; c.dur = end - start;
      } else {
        const next = others.find(x => x.start >= end - 1e-6);
        const hi = Math.min(next ? next.start : Infinity, o.start + maxDur({ ...c, in: o.in }));
        const s = snapTo(T, drag.times); showSnap(s.hit);
        c.dur = clamp(snapFrame(s.t), o.start + MIN_DUR, hi) - o.start;
      }
    }
    touch();
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; showSnap(null);
    if (d.kind !== 'scrub' && d.moved) commit();
  };
  scroll.addEventListener('pointerup', end); scroll.addEventListener('pointercancel', end);

  rows.addEventListener('click', e => {
    const b = e.target.closest('.tl-head button'); if (!b) return;
    const tr = trackOf(b.closest('.tl-row').dataset.track); if (!tr) return;
    if (b.dataset.act === 'hide') tr.hidden = !tr.hidden;
    else if (b.dataset.act === 'mute') tr.muted = !tr.muted;
    else if (b.dataset.act === 'remove') removeTrack(tr.id);
    commit();
  });
  scroll.addEventListener('scroll', () => { drawRuler(); placePlayhead(); });
  scroll.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(S.pps * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 33 : 1) * 0.0022), e.clientX);
  }, { passive: false });
  new ResizeObserver(() => { build(); }).observe(scroll);

  $('#btn-split').addEventListener('click', splitAtPlayhead);
  $('#btn-delete').addEventListener('click', deleteSelected);
  $('#btn-snap').addEventListener('click', () => { S.snap = !S.snap; syncTools(); });
  $('#btn-fit').addEventListener('click', zoomFit);
  $('#zoom').addEventListener('input', e => setZoom(8 * Math.pow(50, +e.target.value / 100)));
  const menu = $('#menu-track'), opener = $('#btn-add-track');
  const closeMenu = () => { menu.hidden = true; opener.setAttribute('aria-expanded', 'false'); };
  opener.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; opener.setAttribute('aria-expanded', String(!menu.hidden)); });
  menu.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; addTrack(b.dataset.kind); closeMenu(); commit(); });
  window.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('.menu-wrap')) closeMenu(); });
}

export function init() {
  scroll = $('#tl-scroll'); rows = $('#tl-rows'); ruler = $('#ruler'); playhead = $('#tl-playhead'); snapline = $('#tl-snapline');
  wire();
  on('project', build);
  on('select', () => { $$('.clip', rows).forEach(n => n.classList.toggle('sel', n.dataset.id === S.sel)); syncTools(); });
  on('media', build);
  on('time', () => {
    placePlayhead(); syncTools();
    if (S.playing) {                                    // keep the playhead in view while playing
      const x = S.t * S.pps, left = scroll.scrollLeft, w = scroll.clientWidth - HEAD_W;
      if (x > left + w - 30 || x < left) scroll.scrollLeft = Math.max(0, x - 60);
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawRuler);
  build();
}
