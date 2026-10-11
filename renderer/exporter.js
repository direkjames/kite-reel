// Turns the project into an export request and runs the export dialog.
import { S, clipsOn, mediaOf, duration, snapFrame, rectOf, isNeutral } from './store.js';
import { compositor, pause } from './player.js';
import { drawText } from './text.js';
import { $, $$, api, waitJob, toast, fmtTime, native } from './util.js';

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * Describes the project for the engine: every picture layer from the back to the front with its place and timing,
 * every sound, and each distinct look as a colour table. Returns { spec, skipped } where skipped counts clips left
 * out because their file is missing.
 */
export function buildSpec(outPath, crf, outHeight) {
  const { w: cw, h: ch, fps } = S.p.canvas, layers = [], audio = [], luts = [], lutIndex = new Map();
  let skipped = 0;
  const lutFor = adj => {
    if (isNeutral(adj)) return -1;
    const key = JSON.stringify(adj);
    if (!lutIndex.has(key)) { lutIndex.set(key, luts.length); luts.push(b64(compositor().cube(adj))); }
    return lutIndex.get(key);
  };
  for (let i = S.p.tracks.length - 1; i >= 0; i--) {
    const tr = S.p.tracks[i];
    for (const c of clipsOn(tr.id)) {
      if (c.kind === 'text') {
        if (tr.hidden) continue;
        const d = drawText(c, cw, ch);
        layers.push({ type: 'text', png: d.canvas.toDataURL('image/png').split(',')[1], start: c.start, dur: c.dur, x: Math.round(d.x), y: Math.round(d.y) });
        continue;
      }
      const m = mediaOf(c.media), rt = S.rt.get(c.media);
      if (!m || !rt || rt.missing) { skipped++; continue; }
      if (c.kind === 'audio') {
        if (!tr.muted && c.volume > 0) audio.push({ layer: -1, id: rt.sid, in: c.in, start: c.start, dur: c.dur, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, mono: m.mono });
        continue;
      }
      let layer = -1;
      if (!tr.hidden && c.opacity > 0) {
        const r = rectOf(c);
        layers.push({ type: c.kind, id: rt.sid, in: c.in, start: c.start, dur: c.dur, x: r.x, y: r.y, w: r.w, h: r.h, opacity: c.opacity, lut: lutFor(c.adj) });
        layer = layers.length - 1;
      }
      if (c.kind === 'video' && m.hasAudio && !tr.muted && c.volume > 0) audio.push({ layer, id: rt.sid, in: c.in, start: c.start, dur: c.dur, volume: c.volume, fadeIn: 0, fadeOut: 0, mono: m.mono });
    }
  }
  return { spec: { outPath, width: cw, height: ch, fps, duration: snapFrame(duration()), crf, outHeight, layers, audio, luts }, skipped };
}

const prefs = { size: 0, crf: 22 };
let job = null, savedTo = '';
function outSize() {
  const { w, h } = S.p.canvas, even = n => Math.max(2, Math.round(n / 2) * 2);
  return prefs.size && prefs.size < h ? [even(w * prefs.size / h), even(prefs.size)] : [w, h];
}
function sync() {
  if (prefs.size && prefs.size >= S.p.canvas.h) prefs.size = 0;
  $$('#seg-size button').forEach(b => { const v = +b.dataset.v; b.disabled = v > 0 && v >= S.p.canvas.h; b.setAttribute('aria-pressed', String(v === prefs.size)); });
  $$('#seg-quality button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v === prefs.crf)));
  const [w, h] = outSize();
  $('#ex-meta').textContent = `MP4 · ${w} × ${h} · ${S.p.canvas.fps} fps · ${fmtTime(duration())} long`;
}
export function openExport() {
  if (duration() <= 0 || $('#dlg').open) return;
  pause(); $('#ex-setup').hidden = false; $('#ex-run').hidden = true; sync(); $('#dlg').showModal();
}
async function run() {
  if (!native) { toast('Exporting needs the Kite Reel app.'); return; }
  const base = S.path ? S.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : 'my-video';
  const outPath = await native.pickSave('video', base + '.mp4');
  if (!outPath) return;
  const status = $('#ex-status'), bar = $('#ex-bar'), detail = $('#ex-detail');
  $('#ex-setup').hidden = true; $('#ex-run').hidden = false;
  status.className = 'status'; status.textContent = 'Exporting… 0%'; bar.style.width = '0%'; detail.textContent = outPath;
  $('#ex-stop').hidden = false; $('#ex-reveal').hidden = true; $('#ex-done').hidden = true;
  const finish = () => { job = null; $('#ex-stop').hidden = true; $('#ex-done').hidden = false; };
  try {
    const [, h] = outSize(), { spec, skipped } = buildSpec(outPath, prefs.crf, h < S.p.canvas.h ? h : 0);
    job = (await api('export', spec)).job;
    const done = await waitJob(job, p => { status.textContent = `Exporting… ${Math.round(p * 100)}%`; bar.style.width = (p * 100).toFixed(1) + '%'; });
    finish();
    if (done.state === 'done') {
      bar.style.width = '100%'; status.textContent = 'Saved'; savedTo = outPath; $('#ex-reveal').hidden = false;
      if (skipped) detail.textContent = `${outPath}\n${skipped} clip${skipped > 1 ? 's were' : ' was'} left out because the file is missing.`;
    } else if (done.state === 'cancelled') { status.textContent = 'Export cancelled'; detail.textContent = 'Nothing was saved.'; }
    else { status.className = 'status bad'; status.textContent = done.error || 'The export did not finish.'; detail.textContent = done.detail || ''; }
  } catch (e) { finish(); status.className = 'status bad'; status.textContent = e.message; detail.textContent = ''; }
}
export function init() {
  const dlg = $('#dlg');
  $('#btn-export').addEventListener('click', openExport);
  $('#ex-cancel').addEventListener('click', () => dlg.close());
  $('#ex-done').addEventListener('click', () => dlg.close());
  $('#ex-go').addEventListener('click', run);
  $('#ex-stop').addEventListener('click', () => { if (job) api('job/' + job + '/cancel', {}).catch(() => {}); });
  $('#ex-reveal').addEventListener('click', () => { if (native && savedTo) native.reveal(savedTo); });
  dlg.addEventListener('cancel', e => { if (job) e.preventDefault(); });           // Esc does not abandon a running export
  $('#seg-size').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { prefs.size = +b.dataset.v; sync(); } });
  $('#seg-quality').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { prefs.crf = +b.dataset.v; sync(); } });
}
