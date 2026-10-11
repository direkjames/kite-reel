// The media library on the left and the properties panel on the right, plus importing and loading projects.
import { S, on, emit, LOOKS, CANVASES, KEYS, freshAdj, mediaOf, selected, commit, touch, select, addMediaClip, addTextClip, setCanvas, duration, fillScale, resetHistory, newProject, trackKindFor } from './store.js';
import { requestRender, seek } from './player.js';
import { dropTarget, clearDrop, zoomFit, reveal } from './timeline.js';
import { FONTS } from './text.js';
import { $, $$, el, api, waitJob, uid, toast, busy, slider, paint, fmtShort, fmtTime, native } from './util.js';

/* ================= importing ================= */
function loadInto(v, src) {
  return new Promise((resolve, reject) => {
    const off = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); clearTimeout(timer); };
    const ok = () => { off(); if (v.videoWidth > 0) resolve(); else reject(new Error('no picture')); };
    const bad = () => { off(); reject(new Error('cannot play')); };
    const timer = setTimeout(bad, 20000);
    v.addEventListener('loadeddata', ok); v.addEventListener('error', bad);
    v.src = src; v.load();
  });
}
const shrink = (source, w, h) => { const k = 320 / Math.max(w, h), c = el('canvas', { width: Math.max(2, Math.round(w * k)), height: Math.max(2, Math.round(h * k)) }); c.getContext('2d').drawImage(source, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.72); };

/** Gets one piece of media ready for this session: a playable address, a thumbnail, and a waveform for sounds. */
async function prepare(m, sid) {
  const rt = { sid, src: 'media/' + sid, thumb: '', wave: '', img: null, missing: false, proxy: false };
  if (m.kind === 'video') {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
    try { await loadInto(v, rt.src); }
    catch (e) {
      // the built-in player cannot show this format, so make a lighter copy just for previewing
      busy(`Making a preview copy of ${m.name}`, 0);
      const { job } = await api('proxy', { id: sid, duration: m.duration });
      const done = await waitJob(job, p => busy(`Making a preview copy of ${m.name}`, p));
      if (done.state !== 'done') throw new Error(`Kite Reel could not read ${m.name}.`);
      rt.src = 'media/' + done.result.id; rt.proxy = true;
      await loadInto(v, rt.src);
    }
    try {
      await new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = Math.min(1, m.duration * 0.25); setTimeout(done, 2500); });
      rt.thumb = shrink(v, v.videoWidth, v.videoHeight);
    } catch (e) { /* a missing thumbnail is not worth failing over */ }
    v.removeAttribute('src'); v.load();
  } else if (m.kind === 'image') {
    rt.img = new Image();
    await new Promise((res, rej) => { rt.img.onload = res; rt.img.onerror = () => rej(new Error(`Kite Reel could not read ${m.name}.`)); rt.img.src = rt.src; });
    rt.thumb = shrink(rt.img, rt.img.naturalWidth, rt.img.naturalHeight);
  } else {
    try { rt.wave = 'media/' + (await api('wave', { id: sid })).id; } catch (e) { /* no waveform: the clip still works */ }
  }
  S.rt.set(m.id, rt);
}
export async function importPaths(paths) {
  const added = [];
  for (const file of paths) {
    const known = S.p.media.find(m => m.path === file);
    if (known) { added.push(known); continue; }
    busy('Importing ' + file.split(/[\\/]/).pop());
    try {
      const info = await api('open', { path: file });
      const m = { id: 'm' + uid(), path: file, name: info.name, kind: info.kind, duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, mono: !!info.mono };
      await prepare(m, info.id);
      S.p.media.push(m); added.push(m);
    } catch (e) { toast(e.message || 'Kite Reel could not import that file.', 6000); }
  }
  busy(null);
  if (added.length) { commit(); emit('media'); }
  return added;
}
export async function pickAndImport() {
  if (!native) { toast('Importing needs the Kite Reel app.'); return; }
  const files = await native.pickOpen('media');
  if (files && files.length) await importPaths(files);
}
/** Replaces the whole project, re-reading every file it uses. Files that have moved are kept but marked missing. */
export async function loadProject(project, path) {
  S.rt.clear(); S.sel = null; S.t = 0;
  S.p = Object.assign(newProject(), project); S.path = path || '';
  let missing = 0;
  for (const m of S.p.media) {
    busy('Opening ' + m.name);
    try { const info = await api('open', { path: m.path }); await prepare(m, info.id); }
    catch (e) { S.rt.set(m.id, { sid: '', src: '', thumb: '', wave: '', img: null, missing: true, proxy: false }); missing++; }
  }
  busy(null);
  resetHistory(); emit('project'); emit('media'); emit('select'); emit('time');
  zoomFit(); seek(0);
  if (missing) toast(`${missing} file${missing > 1 ? 's' : ''} used by this project could not be found. Those clips are left out until the files are back.`, 7000);
}

/* ================= media library ================= */
const KIND_ICON = {
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="16.500" cy="16" r="2.500"/></svg>',
  missing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16v.5"/></svg>',
};
function addToTimeline(m, track, time) {
  const c = addMediaClip(m.id, track, time);
  if (!c) return;
  commit(); select(c.id);
  if (S.p.clips.length === 1) zoomFit(); else reveal(c.start + c.dur);
}
function buildBin() {
  const list = $('#bin-list'); list.textContent = '';
  $('#bin-empty').hidden = S.p.media.length > 0;
  for (const m of S.p.media) {
    const rt = S.rt.get(m.id) || {};
    const pic = el('div', { className: 'pic' });
    if (rt.missing) pic.innerHTML = KIND_ICON.missing; else if (rt.thumb) pic.style.backgroundImage = `url("${rt.thumb}")`; else if (m.kind === 'audio') pic.innerHTML = KIND_ICON.audio;
    if (m.kind !== 'image') pic.append(el('span', { className: 'len', textContent: fmtShort(m.duration) }));
    const add = el('button', { type: 'button', className: 'add', textContent: '+', title: 'Add to the end of the timeline' }); add.setAttribute('aria-label', 'Add ' + m.name + ' to the timeline');
    pic.append(add);
    const item = el('div', { className: 'item' + (rt.missing ? ' missing' : ''), title: rt.missing ? m.path + ' (not found)' : m.name }, [pic, el('span', { className: 'nm', textContent: m.name })]);
    item.dataset.id = m.id;
    list.append(item);
  }
}
function wireBin() {
  const list = $('#bin-list'), ghost = $('#ghost');
  let drag = null;
  list.addEventListener('click', e => { const b = e.target.closest('.add'); if (b) { const m = mediaOf(b.closest('.item').dataset.id); if (m) addToTimeline(m); } });
  list.addEventListener('dblclick', e => { const it = e.target.closest('.item'); if (it && !e.target.closest('.add')) { const m = mediaOf(it.dataset.id); if (m) addToTimeline(m); } });
  // drag a tile onto a track
  list.addEventListener('pointerdown', e => {
    const it = e.target.closest('.item'); if (!it || e.target.closest('.add') || e.button !== 0) return;
    const m = mediaOf(it.dataset.id); if (!m || (S.rt.get(m.id) || {}).missing) return;
    try { list.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    drag = { id: e.pointerId, m, x0: e.clientX, y0: e.clientY, on: false };
  });
  list.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.on = true; ghost.hidden = false; ghost.textContent = drag.m.name;
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    dropTarget(e.clientX, e.clientY, trackKindFor(drag.m.kind));
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; ghost.hidden = true;
    const t = d.on && e.type === 'pointerup' ? dropTarget(e.clientX, e.clientY, trackKindFor(d.m.kind)) : null;
    clearDrop();
    if (t) addToTimeline(d.m, t.track, t.time);
  };
  list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
  $('#btn-import').addEventListener('click', pickAndImport); $('#btn-import-2').addEventListener('click', pickAndImport);
  $('#btn-add-text').addEventListener('click', addText);
}
export function addText() { const c = addTextClip(S.t); commit(); select(c.id); if (S.p.clips.length === 1) zoomFit(); }

/* ================= properties ================= */
let refreshers = [];     // functions that copy the clip's current values back into the controls
const live = input => input.matches(':active') || (input === document.activeElement && input.tagName === 'TEXTAREA');
function prop(c, key, o) {
  // a slider bound to one number on the clip; `to` and `from` convert between what is stored and what is shown
  const to = o.to || (v => v), from = o.from || (v => v);
  const row = slider({ ...o, value: to(c[key]), rest: o.rest === undefined ? 0 : o.rest,
    onInput: v => { c[key] = from(v); if (o.then) o.then(); touch(); }, onDone: () => commit() });
  const input = row.querySelector('input');
  refreshers.push(() => { if (!live(input)) { input.value = to(c[key]); paint(input); } });
  return row;
}
const seg = (options, current, onPick) => {
  const box = el('div', { className: 'seg' });
  options.forEach(([v, label]) => { const b = el('button', { type: 'button', textContent: label }); b.dataset.v = v; b.setAttribute('aria-pressed', String(v === current())); b.addEventListener('click', () => { onPick(v); commit(); }); box.append(b); });
  refreshers.push(() => $$('button', box).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(current())))));
  return box;
};
const check = (id, label, get, set) => {
  const input = el('input', { type: 'checkbox', id }); input.checked = get();
  input.addEventListener('change', () => { set(input.checked); commit(); });
  refreshers.push(() => { input.checked = get(); });
  return el('label', { className: 'check', htmlFor: id }, [input, label]);
};
const head = (title, detail) => el('div', { className: 'pane-head' }, [el('h2', { textContent: title }), el('span', { className: 'kind', textContent: detail || '', title: detail || '' })]);
const sub = text => el('h3', { className: 'sub', textContent: text });
const pct = v => Math.round(v) + '%';

function videoPanel(c, box) {
  const m = mediaOf(c.media);
  box.append(head(c.kind === 'image' ? 'Photo' : 'Video', m ? m.name : ''));
  box.append(sub('Look'));
  const looks = el('div', { className: 'looks' });
  LOOKS.forEach(L => {
    const chip = el('i'); chip.style.background = L.chip;
    const b = el('button', { type: 'button', className: 'look', id: 'look-' + L.id }, [chip, el('span', { textContent: L.name })]);
    b.addEventListener('click', () => { c.adj = { ...L.adj }; c.look = L.id; commit(); });
    looks.append(b);
  });
  refreshers.push(() => LOOKS.forEach(L => $('#look-' + L.id, looks).setAttribute('aria-pressed', String(c.look === L.id))));
  box.append(looks);
  const adj = (key, label, extra = {}) => {
    const row = slider({ id: 's-' + key, label, value: c.adj[key], ...extra, onInput: v => { c.adj[key] = v; c.look = null; touch(); }, onDone: () => commit() });
    const input = row.querySelector('input');
    refreshers.push(() => { if (!live(input)) { input.value = c.adj[key]; paint(input); } });
    return row;
  };
  const stops = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  box.append(sub('Light'), adj('exposure', 'Exposure', { min: -3, max: 3, step: 0.01, fmt: stops }), adj('contrast', 'Contrast'), adj('highlights', 'Highlights'), adj('shadows', 'Shadows'), adj('whites', 'Whites'), adj('blacks', 'Blacks'));
  box.append(sub('Color'), adj('temp', 'Warmth', { grad: 'linear-gradient(to right,#3b82f6,var(--track) 50%,#f5b83d)' }), adj('tint', 'Tint', { grad: 'linear-gradient(to right,#3fae5a,var(--track) 50%,#d946b8)' }), adj('vibrance', 'Vibrance'), adj('saturation', 'Saturation'));
  box.append(sub('Size and position'),
    prop(c, 'scale', { id: 's-scale', label: 'Size', min: 10, max: 400, rest: 100, fmt: pct, to: v => v * 100, from: v => v / 100 }),
    prop(c, 'opacity', { id: 's-opacity', label: 'Opacity', min: 0, max: 100, rest: 100, fmt: pct, to: v => v * 100, from: v => v / 100 }));
  const fit = el('button', { type: 'button', className: 'btn small', id: 'btn-fit-frame', textContent: 'Fit the frame', title: 'Show the whole picture' });
  const fill = el('button', { type: 'button', className: 'btn small', id: 'btn-fill-frame', textContent: 'Fill the frame', title: 'Cover the frame, cropping the edges' });
  fit.addEventListener('click', () => { c.scale = 1; c.x = 0; c.y = 0; commit(); });
  fill.addEventListener('click', () => { c.scale = fillScale(c); c.x = 0; c.y = 0; commit(); });
  box.append(el('div', { className: 'pair' }, [fit, fill]));
  if (c.kind === 'video' && m && m.hasAudio) box.append(sub('Sound'), prop(c, 'volume', { id: 's-volume', label: 'Volume', min: 0, max: 100, rest: 100, fmt: v => (v === 0 ? 'Muted' : pct(v)), to: v => v * 100, from: v => v / 100 }));
  box.append(el('p', { className: 'hint', textContent: 'Drag the picture in the preview to move it. Drag the round handle to resize it.' }));
}
function audioPanel(c, box) {
  const m = mediaOf(c.media), secs = v => v.toFixed(1) + ' s';
  box.append(head('Sound', m ? m.name : ''),
    prop(c, 'volume', { id: 's-volume', label: 'Volume', min: 0, max: 100, rest: 100, fmt: v => (v === 0 ? 'Muted' : pct(v)), to: v => v * 100, from: v => v / 100 }),
    prop(c, 'fadeIn', { id: 's-fade-in', label: 'Fade in', min: 0, max: 5, step: 0.1, fmt: secs }),
    prop(c, 'fadeOut', { id: 's-fade-out', label: 'Fade out', min: 0, max: 5, step: 0.1, fmt: secs }));
}
const TEXT_COLORS = ['#ffffff', '#111111', '#ffd23e', '#ff5a4e', '#38a0ff', '#3fd08a'];
function textPanel(c, box) {
  box.append(head('Text'));
  const area = el('textarea', { id: 'text-content', rows: 3, spellcheck: false }); area.value = c.text;
  area.addEventListener('input', () => { c.text = area.value; touch(); });
  area.addEventListener('change', () => commit());
  refreshers.push(() => { if (!live(area) && area.value !== c.text) area.value = c.text; });
  box.append(el('div', { className: 'field' }, [el('label', { htmlFor: 'text-content', textContent: 'Words' }), area]));
  const font = el('select', { id: 'text-font' });
  FONTS.forEach(f => font.append(el('option', { value: f, textContent: f })));
  font.value = c.font; font.addEventListener('change', () => { c.font = font.value; commit(); });
  refreshers.push(() => { font.value = c.font; });
  box.append(el('div', { className: 'field' }, [el('label', { htmlFor: 'text-font', textContent: 'Font' }), font]));
  box.append(prop(c, 'size', { id: 's-size', label: 'Size', min: 2, max: 40, step: 0.5, rest: 9, fmt: v => v.toFixed(1), to: v => v * 100, from: v => v / 100 }));
  const sw = el('div', { className: 'swatches' });
  TEXT_COLORS.forEach(col => { const b = el('button', { type: 'button', title: col }); b.style.background = col; b.dataset.v = col; b.setAttribute('aria-label', 'Colour ' + col); b.addEventListener('click', () => { c.color = col; commit(); }); sw.append(b); });
  const custom = el('input', { type: 'color', id: 'text-color', title: 'Any colour' }); custom.value = c.color;
  custom.addEventListener('input', () => { c.color = custom.value; touch(); }); custom.addEventListener('change', () => commit());
  sw.append(custom);
  refreshers.push(() => { $$('button', sw).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === c.color))); if (!live(custom)) custom.value = c.color; });
  box.append(el('div', { className: 'field' }, [el('span', { textContent: 'Colour' }), sw]));
  box.append(el('div', { className: 'field' }, [el('span', { textContent: 'Line up' }), seg([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], () => c.align, v => { c.align = v; })]));
  box.append(el('div', { className: 'checks' }, [
    check('text-bold', 'Bold', () => c.bold, v => { c.bold = v; }),
    check('text-outline', 'Outline', () => c.outline, v => { c.outline = v; }),
    check('text-bg', 'Background', () => c.bg, v => { c.bg = v; }),
  ]));
  const mid = el('button', { type: 'button', className: 'btn small', textContent: 'Centre in the frame' });
  mid.addEventListener('click', () => { c.x = 0; c.y = 0; commit(); });
  box.append(el('div', { className: 'pair' }, [mid]));
  box.append(el('p', { className: 'hint', textContent: 'Drag the text in the preview to move it.' }));
}
function projectPanel(box) {
  box.append(head('Project'));
  box.append(el('div', { className: 'field' }, [el('span', { textContent: 'Frame shape' }),
    seg(Object.keys(CANVASES).map(k => [k, k]), () => S.p.canvas.shape, v => { setCanvas(v); })]));
  const info = el('p', { className: 'hint', id: 'project-info' });
  refreshers.push(() => { info.textContent = `${S.p.canvas.w} × ${S.p.canvas.h}, ${S.p.canvas.fps} frames a second, ${fmtTime(duration())} long.`; });
  box.append(info, el('p', { className: 'hint', textContent: 'Select a clip on the timeline to change it.' }));
  box.append(el('p', { className: 'version', id: 'version', textContent: projectPanel.version || '' }));
}
let shownFor = null;
function buildInspector() {
  const box = $('#inspector'), c = selected();
  refreshers = []; box.textContent = ''; shownFor = c ? c.id : '';
  if (!c) projectPanel(box);
  else if (c.kind === 'text') textPanel(c, box);
  else if (c.kind === 'audio') audioPanel(c, box);
  else videoPanel(c, box);
  refreshers.forEach(f => f());
}
let boundClip = null;
/** Brings the panel up to date. Undo and redo replace the clip objects, so then the panel is rebuilt around the new one. */
function syncInspector() {
  const c = selected();
  if (c !== boundClip || (c ? c.id : '') !== shownFor) { boundClip = c; buildInspector(); }
  else refreshers.forEach(f => f());
}

export function init() {
  wireBin();
  on('media', buildBin);
  on('project', () => { if (S.p.media.length !== $$('#bin-list .item').length) buildBin(); syncInspector(); syncInfo(); });
  on('select', syncInspector);
  on('history', syncInspector);
  on('time', syncInfo);
  api('info').then(i => { projectPanel.version = 'Kite Reel ' + i.version; const v = $('#version'); if (v) v.textContent = projectPanel.version; }).catch(() => {});
  buildBin(); syncInspector(); buildInspector(); syncInfo();
}
function syncInfo() {
  $('#t-now').textContent = fmtTime(S.t); $('#t-total').textContent = ' / ' + fmtTime(duration());
  $('#canvas-info').textContent = `${S.p.canvas.shape} · ${S.p.canvas.w} × ${S.p.canvas.h}`;
  $('#btn-export').disabled = duration() <= 0;
  const none = S.p.clips.length === 0, imported = S.p.media.length > 0;
  $('#empty').hidden = !none;
  $('#empty-title').textContent = imported ? 'Now build your video' : 'Import media to start';
  $('#empty-text').textContent = imported ? 'Drag a file from the Media list onto a track, or press the + on it.' : 'Bring in videos, photos and sounds, then drag them onto the timeline below.';
  $('#btn-import-2').hidden = imported;
}
