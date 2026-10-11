// Small helpers shared by every part of the editor screen.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 9);
export const el = (tag, props = {}, kids = []) => { const n = Object.assign(document.createElement(tag), props); kids.forEach(k => n.append(k)); return n; };
export const native = window.kiteNative || null;      // file dialogs and updates, provided by the Windows app

export async function api(route, body) {
  const res = await fetch('api/' + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
export async function waitJob(id, onProgress) {
  for (;;) {
    const s = await api('job/' + id);
    if (s.state !== 'running') return s;
    onProgress(s.progress); await sleep(250);
  }
}

/** 75.5 -> "01:15.50" */
export function fmtTime(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
export const fmtShort = t => { t = Math.max(0, Math.round(t)); return `${Math.floor(t / 60)}:${t % 60 < 10 ? '0' : ''}${t % 60}`; };

export function toast(text, ms = 4200) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
export function busy(text, fraction) {
  const b = $('#busy');
  if (text === null) { b.hidden = true; return; }
  b.hidden = false; $('#busy-text').textContent = text;
  $('#busy-bar').parentElement.hidden = fraction === undefined;
  $('#busy-bar').style.width = Math.round((fraction || 0) * 100) + '%';
}
/** A yes-or-no question in the app's own window. Resolves true for yes. */
export function ask(title, text, yes = 'OK') {
  return new Promise(resolve => {
    const d = $('#dlg-ask');
    $('#ask-title').textContent = title; $('#ask-text').textContent = text; $('#ask-yes').textContent = yes;
    const done = v => { d.removeEventListener('close', onClose); $('#ask-yes').onclick = $('#ask-no').onclick = null; if (d.open) d.close(); resolve(v); };
    const onClose = () => done(false);
    d.addEventListener('close', onClose);
    $('#ask-yes').onclick = () => done(true); $('#ask-no').onclick = () => done(false);
    d.showModal();
  });
}

/* sliders */
export const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v));
export function paint(input) {
  const min = +input.min, max = +input.max, v = +input.value, row = input.closest('.row');
  if (row) { row.querySelector('output').textContent = input._fmt ? input._fmt(v) : v; row.classList.toggle('on', v !== +(input.dataset.rest || 0)); }
  if (input.dataset.grad) { input.style.setProperty('--trk', input.dataset.grad); return; }
  const at = p => `calc(var(--tw) / 2 + (100% - var(--tw)) * ${p.toFixed(4)})`;
  const pos = (v - min) / (max - min), zero = clamp((0 - min) / (max - min), 0, 1), a = at(Math.min(pos, zero)), b = at(Math.max(pos, zero));
  input.style.setProperty('--trk', `linear-gradient(to right,var(--track) ${a},var(--accent) ${a},var(--accent) ${b},var(--track) ${b})`);
}
/** One labelled slider. onInput fires while dragging, onDone when the drag ends. Double-click returns it to its resting value. */
export function slider({ id, label, min = -100, max = 100, step = 1, value = 0, rest = 0, fmt = signed, grad = '', onInput, onDone }) {
  const input = el('input', { type: 'range', id, min, max, step });
  input.value = value; input.dataset.rest = rest; input._fmt = fmt;
  if (grad) input.dataset.grad = grad;
  const row = el('div', { className: 'row' }, [el('label', { htmlFor: id, textContent: label }), el('output', {}), input]);
  input.addEventListener('input', () => { paint(input); if (onInput) onInput(+input.value); });
  input.addEventListener('change', () => { if (onDone) onDone(+input.value); });
  input.addEventListener('dblclick', () => { input.value = rest; paint(input); if (onInput) onInput(+rest); if (onDone) onDone(+rest); });
  paint(input);
  return row;
}
