// The multi-track timeline: tracks, clips, ruler and playhead, and everything you do to clips with the pointer.
import { S, on, clipOf, trackOf, mediaOf, clipsOn, duration, snapFrame, frameLen, select, toggleSel, selectCut, isSel, selection, commit, touch, addTrack, removeTrack, splitClip, removeClip, freeStart, maxDur,
  speedOf, prevTouching, linkIn, groupShift, copySelection, pasteAt, hasCopied } from './store.js';
import { seek, pause } from './player.js';
import { $, $$, el, clamp, fmtShort, toast } from './util.js';

const HEAD_W = 150, SNAP_PX = 8, MIN_DUR = 0.1;
let scroll, rows, ruler, playhead, snapline, marquee;

const ICON = {
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5l11 11M6.2 4A6 6 0 0 1 8 3.5c4 0 6.5 4.500 6.500 4.500a12 12 0 0 1-2 2.500M10 11.900A6 6 0 0 1 8 12.500C4 12.500 1.500 8 1.500 8a12 12 0 0 1 2.600-3"/></svg>',
  sound: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.500L8.500 13V3L5 6z"/><path d="M11 5.500a3.500 3.500 0 0 1 0 5"/></svg>',
  soundOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.500L8.500 13V3L5 6z"/><path d="M11 6l3 4M14 6l-3 4"/></svg>',
  remove: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.500 4.500l7 7M11.500 4.500l-7 7"/></svg>',
  plus: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 2.500v7M2.500 6h7"/></svg>',
  dissolve: '<svg viewBox="0 0 14 12" fill="currentColor"><path d="M1 2l6 4-6 4z" opacity=".55"/><path d="M13 2L7 6l6 4z"/></svg>',
  flash: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M7 .800 2.500 6.800h3L4.800 11.200 9.500 5.200h-3z"/></svg>',
};
const iconButton = (svg, title, pressed) => { const b = el('button', { type: 'button', title }); b.innerHTML = svg; b.setAttribute('aria-label', title); if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed)); return b; };

const lanesWidth = () => Math.max(scroll.clientWidth - HEAD_W, (duration() + 8) * S.pps);
/** The timeline time under a point on the screen. */
const timeAt = clientX => (clientX - scroll.getBoundingClientRect().left - HEAD_W + scroll.scrollLeft) / S.pps;

/* ---------- drawing ---------- */
function clipNode(c) {
  const m = c.media ? mediaOf(c.media) : null, rt = c.media ? S.rt.get(c.media) : null;
  const d = el('div', { className: `clip k-${c.kind}${isSel(c.id) ? ' sel' : ''}${rt && rt.missing ? ' missing' : ''}` });
  d.dataset.id = c.id;
  d.style.left = c.start * S.pps + 'px'; d.style.width = Math.max(2, c.dur * S.pps - 1) + 'px';
  if ((c.kind === 'video' || c.kind === 'image') && rt && rt.thumb) d.style.backgroundImage = `url("${rt.thumb}")`;
  if (c.kind === 'audio' && rt && rt.wave && m) {
    const w = el('div', { className: 'wave' });
    w.style.webkitMaskImage = `url("${rt.wave}")`; w.style.webkitMaskSize = `${m.duration / speedOf(c) * S.pps}px 100%`; w.style.webkitMaskPosition = `${-c.in / speedOf(c) * S.pps}px 0`;
    d.append(w);
  }
  let label = c.kind === 'text' ? String(c.text).split('\n')[0] || 'Text' : rt && rt.missing ? `${m ? m.name : 'File'} (missing)` : m ? m.name : '';
  if (speedOf(c) !== 1) label += ` · ${speedOf(c)}×`;
  // a wedge at each end shows how long the clip takes to fade in and out
  for (const [key, side] of [['fadeIn', 'in'], ['fadeOut', 'out']]) if (c[key] > 0) { const f = el('i', { className: 'fade ' + side }); f.style.width = Math.min(c[key], c.dur) * S.pps + 'px'; d.append(f); }
  d.append(el('span', { className: 'nm', textContent: label }), el('i', { className: 'edge l' }), el('i', { className: 'edge r' }));
  return d;
}
/** The small button on the join between two touching clips: it is where a transition is added and shown. */
function cutNode(c) {
  const link = linkIn(c), b = el('button', { type: 'button', className: `cut${link ? ' on' : ''}${S.cut === c.id ? ' sel' : ''}`, tabIndex: -1 });
  b.dataset.cut = c.id;
  b.title = link ? `${link.type === 'flash' ? 'Flash' : 'Dissolve'} transition` : 'Add a transition';
  b.setAttribute('aria-label', b.title);
  b.innerHTML = link ? ICON[link.type] : ICON.plus;
  b.style.left = c.start * S.pps + 'px';
  if (link) b.style.width = Math.max(18, link.dur * S.pps) + 'px';
  return b;
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
    if (tr.kind !== 'audio') clipsOn(tr.id).forEach(c => { if (prevTouching(c)) lane.append(cutNode(c)); });
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
  $('#btn-delete').disabled = !S.sel.length && !(S.cut && clipOf(S.cut) && clipOf(S.cut).trans);
  $('#btn-copy').disabled = !S.sel.length; $('#btn-paste').disabled = !hasCopied();
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
  const under = c => S.t > c.start && S.t < c.start + c.dur;
  const picked = selection().filter(under), targets = picked.length ? picked : S.p.clips.filter(under);
  let did = false;
  targets.forEach(c => { if (splitClip(c, S.t)) did = true; });
  if (did) commit();
}
export function deleteSelected() {
  const join = S.cut ? clipOf(S.cut) : null;
  if (join) { if (join.trans) { delete join.trans; commit(); } return; }      // with a join selected, Delete takes its transition off
  const cs = selection(); if (!cs.length) return;
  cs.forEach(c => removeClip(c.id)); commit(); select(null);
}
export function copy() {
  const n = copySelection(); if (!n) return;
  syncTools(); toast(n > 1 ? `${n} clips copied` : 'Clip copied', 1600);
}
export function cut() { if (!copySelection()) return; deleteSelected(); syncTools(); }
/** Pastes at the playhead, or (duplicate) straight after the clips that were copied. */
export function paste(after) {
  if (!hasCopied()) return;
  const ids = pasteAt(after === undefined ? S.t : after); if (!ids.length) return;
  commit(); select(ids);
  reveal(Math.max(...ids.map(id => { const c = clipOf(id); return c.start + c.dur; })));
}
export function duplicate() {
  const cs = selection(); if (!cs.length) return;
  copySelection(); paste(Math.max(...cs.map(c => c.start + c.dur)));
}
export function selectAll() { select(S.p.clips.map(c => c.id)); }

/** Times worth snapping to: the start, the playhead, and every other clip's edges. */
function snapTimes(exceptIds) {
  const t = [0, S.t];
  for (const c of S.p.clips) if (!exceptIds.includes(c.id)) t.push(c.start, c.start + c.dur);
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
  const contentXY = e => { const b = $('#tl-content').getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  scroll.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const head = e.target.closest('.tl-head'); if (head || e.target.closest('.tl-corner')) return;
    const sb = scroll.getBoundingClientRect();
    if (e.clientX > sb.left + scroll.clientWidth || e.clientY > sb.top + scroll.clientHeight) return;      // the scroll bars keep working as usual
    if (e.clientX < sb.left + HEAD_W) return;
    const onRuler = !!e.target.closest('.tl-ruler'), join = onRuler ? null : e.target.closest('.cut'), node = onRuler ? null : e.target.closest('.clip');
    e.preventDefault();
    if (join) { selectCut(join.dataset.cut); return; }
    const many = e.ctrlKey || e.metaKey || e.shiftKey;
    if (node && many) { toggleSel(node.dataset.id); return; }               // Ctrl or Shift and a click adds a clip to the selection, or takes it out
    try { scroll.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    if (node) {
      const c = clipOf(node.dataset.id); if (!c) return;
      const edge = e.target.closest('.edge'), group = !edge && isSel(c.id) && S.sel.length > 1;
      if (!group) select(c.id);
      const ids = group ? [...S.sel] : [c.id];
      drag = { id: e.pointerId, kind: edge ? (edge.classList.contains('l') ? 'trim-l' : 'trim-r') : group ? 'group' : 'move', c, x0: e.clientX, grab: timeAt(e.clientX) - c.start,
        o: { start: c.start, dur: c.dur, in: c.in || 0, track: c.track }, starts: ids.map(id => [clipOf(id), clipOf(id).start]), times: snapTimes(ids), moved: false };
    } else if (onRuler) {
      pause(); seek(timeAt(e.clientX));
      drag = { id: e.pointerId, kind: 'scrub' };
    } else {
      // empty space: a click puts the playhead there and clears the selection; a drag draws a box that selects what it touches
      select(null); pause(); seek(timeAt(e.clientX));
      const [x, y] = contentXY(e);
      drag = { id: e.pointerId, kind: 'box', x0: e.clientX, y0: e.clientY, cx: x, cy: y, moved: false };
    }
  });
  scroll.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.kind === 'scrub') { seek(timeAt(e.clientX)); return; }
    if (drag.kind === 'box') {
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      const [x, y] = contentXY(e), l = Math.min(x, drag.cx), t = Math.min(y, drag.cy), w = Math.abs(x - drag.cx), h = Math.abs(y - drag.cy);
      marquee.hidden = false; marquee.style.left = l + 'px'; marquee.style.top = t + 'px'; marquee.style.width = w + 'px'; marquee.style.height = h + 'px';
      const m = marquee.getBoundingClientRect();
      select($$('.clip', rows).filter(n => { const b = n.getBoundingClientRect(); return b.left < m.right && b.right > m.left && b.top < m.bottom && b.bottom > m.top; }).map(n => n.dataset.id));
      return;
    }
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return;
    drag.moved = true;
    const c = drag.c, o = drag.o, T = timeAt(e.clientX), sp = speedOf(c);
    if (drag.kind === 'move' || drag.kind === 'group') {
      let start = T - drag.grab;
      const a = snapTo(start, drag.times), b = snapTo(start + c.dur, drag.times);
      let hit = null;
      if (a.hit !== null && (b.hit === null || Math.abs(a.t - start) <= Math.abs(b.t - (start + c.dur)))) { start = a.t; hit = a.hit; }
      else if (b.hit !== null) { start = b.t - c.dur; hit = b.hit; }
      const want = snapFrame(Math.max(0, start));
      if (drag.kind === 'group') {                                                          // the selected clips keep their spacing and their tracks
        drag.starts.forEach(([g, s0]) => { g.start = s0; });
        const by = groupShift(drag.starts.map(([g]) => g.id), want - o.start);
        drag.starts.forEach(([g, s0]) => { g.start = snapFrame(s0 + by); });
        showSnap(hit !== null && Math.abs(o.start + by - want) < 1e-6 ? hit : null);
      } else {
        const row = rowAt(e.clientY), tr = row ? trackOf(row.dataset.track) : null;
        if (tr && tr.kind === trackOf(o.track).kind) c.track = tr.id;                    // clips can move between tracks of their own kind
        const placed = freeStart(c.track, want, c.dur, c.id);
        showSnap(hit !== null && Math.abs(placed - want) < 1e-6 ? hit : null);
        c.start = placed;
      }
    } else {
      const others = clipsOn(c.track, c.id), end = o.start + o.dur, source = c.media && mediaOf(c.media) && mediaOf(c.media).kind !== 'image';
      if (drag.kind === 'trim-l') {
        const prev = others.filter(x => x.start + x.dur <= o.start + 1e-6).pop();
        const lo = Math.max(prev ? prev.start + prev.dur : 0, source ? o.start - o.in / sp : 0);
        const s = snapTo(T, drag.times); showSnap(s.hit);
        const start = clamp(snapFrame(s.t), lo, end - MIN_DUR);
        if ('in' in c) c.in = Math.max(0, o.in + (start - o.start) * sp);
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
    const d = drag; drag = null; showSnap(null); marquee.hidden = true;
    if (d.kind === 'scrub' || d.kind === 'box') return;
    if (d.moved) commit();
    else if (d.kind === 'group') select(d.c.id);                                         // a plain click on one of several selected clips picks just that one
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
  $('#btn-copy').addEventListener('click', copy); $('#btn-paste').addEventListener('click', () => paste());
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
  scroll = $('#tl-scroll'); rows = $('#tl-rows'); ruler = $('#ruler'); playhead = $('#tl-playhead'); snapline = $('#tl-snapline'); marquee = $('#tl-marquee');
  wire();
  on('project', build);
  on('select', () => { $$('.clip', rows).forEach(n => n.classList.toggle('sel', isSel(n.dataset.id))); $$('.cut', rows).forEach(n => n.classList.toggle('sel', n.dataset.cut === S.cut)); syncTools(); });
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
