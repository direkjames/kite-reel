// Starts the editor and connects the top bar, the keyboard and the Windows app's services.
import { S, on, newProject, resetHistory, emit, undo, redo, canUndo, canRedo, duration, frameLen, select } from './store.js';
import * as player from './player.js';
import * as timeline from './timeline.js';
import * as panels from './panels.js';
import * as exporter from './exporter.js';
import { $, $$, api, toast, ask, native } from './util.js';

function syncBar() {
  $('#doc-name').textContent = S.path ? S.path.split(/[\\/]/).pop().replace(/\.kitereel$/i, '') : 'Untitled project';
  $('#doc-state').textContent = S.dirty ? 'Edited' : S.path ? 'Saved' : '';
  $('#btn-undo').disabled = !canUndo(); $('#btn-redo').disabled = !canRedo();
  const playing = S.playing;
  $('#ico-play').toggleAttribute('hidden', playing); $('#ico-pause').toggleAttribute('hidden', !playing);
  $('#btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/* ---------- project files ---------- */
const hasWork = () => S.p.clips.length > 0 || S.p.media.length > 0;
async function saveProject(saveAs = false) {
  if (!native) { toast('Saving needs the Kite Reel app.'); return false; }
  let file = S.path;
  if (!file || saveAs) file = await native.pickSave('project', (S.path ? S.path.split(/[\\/]/).pop() : 'My project.kitereel'));
  if (!file) return false;
  try { await api('project/save', { path: file, project: S.p }); }
  catch (e) { toast(e.message, 6000); return false; }
  S.path = file; S.dirty = false; syncBar();
  api('state', { project: S.p, path: S.path }).catch(() => {});
  toast('Project saved');
  return true;
}
async function openProject() {
  if (!native) { toast('Opening projects needs the Kite Reel app.'); return; }
  if (S.dirty && hasWork() && !(await ask('Open another project?', 'Changes to this project that you have not saved will be lost.', 'Open'))) return;
  const files = await native.pickOpen('project');
  if (!files || !files.length) return;
  try { const { project } = await api('project/open', { path: files[0] }); player.pause(); await panels.loadProject(project, files[0]); syncBar(); }
  catch (e) { toast(e.message, 6000); }
}
async function startNew() {
  if (hasWork() && S.dirty && !(await ask('Start a new project?', 'Changes to this project that you have not saved will be lost.', 'Start new'))) return;
  player.pause();
  await panels.loadProject(newProject(), '');
  api('state', { project: null, path: '' }).catch(() => {});
  syncBar();
}

/* ---------- updates ---------- */
function onUpdate(s) {
  const box = $('#update'), text = $('#update-text'), btn = $('#btn-update');
  if (!s || s.state === 'none' || s.state === 'checking' || s.state === 'error') { box.hidden = true; return; }
  box.hidden = false; btn.hidden = s.state !== 'ready';
  text.textContent = s.state === 'ready' ? `Version ${s.version} is ready.` : s.state === 'downloading' ? `Downloading update ${Math.round(s.percent || 0)}%` : `Update ${s.version} found`;
}

function wire() {
  $('#btn-new').addEventListener('click', startNew);
  $('#btn-open').addEventListener('click', openProject);
  $('#btn-save').addEventListener('click', () => saveProject(false));
  $('#btn-undo').addEventListener('click', undo); $('#btn-redo').addEventListener('click', redo);
  $('#btn-play').addEventListener('click', player.toggle);
  $('#btn-start').addEventListener('click', () => player.seek(0));
  $('#btn-end').addEventListener('click', () => player.seek(duration()));

  window.addEventListener('keydown', e => {
    if ($$('dialog[open]').length) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), tag = e.target.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox');
    if (mod && k === 's') { e.preventDefault(); saveProject(e.shiftKey); return; }
    if (mod && k === 'o') { e.preventDefault(); openProject(); return; }
    if (mod && k === 'i') { e.preventDefault(); panels.pickAndImport(); return; }
    if (mod && k === 'e') { e.preventDefault(); exporter.openExport(); return; }
    if (typing) return;                                    // the keys below would get in the way of writing text
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'b') { e.preventDefault(); timeline.splitAtPlayhead(); return; }
    if (mod && k === 'c') { e.preventDefault(); timeline.copy(); return; }
    if (mod && k === 'x') { e.preventDefault(); timeline.cut(); return; }
    if (mod && k === 'v') { e.preventDefault(); timeline.paste(); return; }
    if (mod && k === 'd') { e.preventDefault(); timeline.duplicate(); return; }
    if (mod && k === 'a') { e.preventDefault(); timeline.selectAll(); return; }
    if (mod) return;
    if (e.code === 'Space') { e.preventDefault(); if (tag === 'BUTTON') e.target.blur(); player.toggle(); }      // Space always plays or pauses, whatever was clicked last
    else if (k === 's') timeline.splitAtPlayhead();
    else if (k === 't') panels.addText();
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel.length || S.cut) { e.preventDefault(); timeline.deleteSelected(); } }
    else if (e.key === 'Escape') select(null);
    else if (tag === 'INPUT') return;                      // arrow keys belong to the slider that has focus
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); player.pause(); player.seek(S.t + (e.shiftKey ? 1 : frameLen()) * (e.key === 'ArrowLeft' ? -1 : 1)); }
    else if (e.key === 'Home') player.seek(0);
    else if (e.key === 'End') player.seek(duration());
    else if (e.key === '=' || e.key === '+') timeline.setZoom(S.pps * 1.4);
    else if (e.key === '-') timeline.setZoom(S.pps / 1.4);
  });

  window.addEventListener('keyup', e => { if (e.code === 'Space' && e.target.tagName === 'BUTTON' && !$$('dialog[open]').length) e.preventDefault(); });

  // files dropped anywhere on the window are imported
  let depth = 0;
  const files = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (files(e)) { depth++; $('#drop').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', e => { if (files(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (files(e) && --depth <= 0) { depth = 0; $('#drop').hidden = true; } });
  window.addEventListener('drop', e => {
    if (!files(e)) return;
    e.preventDefault(); depth = 0; $('#drop').hidden = true;
    const paths = native ? [...e.dataTransfer.files].map(f => native.pathForFile(f)).filter(Boolean) : [];
    if (paths.length) panels.importPaths(paths); else toast('Kite Reel could not find those files. Use Import.');
  });

  on('history', syncBar); on('play', syncBar); on('project', syncBar);
  if (native) { native.onUpdate(onUpdate); $('#btn-update').addEventListener('click', () => native.installUpdate()); }
}

async function start() {
  try { player.init(); }
  catch (e) {
    toast('Kite Reel needs graphics acceleration, and it is turned off on this PC. Updating the graphics driver usually fixes this.', 60000);
    $$('button').forEach(b => { b.disabled = true; });
    return;
  }
  timeline.init(); panels.init(); exporter.init();
  wire(); resetHistory(); syncBar(); emit('project'); timeline.zoomFit();
  // pick up where the last session left off
  try {
    const last = await api('state');
    if (last.project && (last.project.clips || []).length + (last.project.media || []).length > 0) {
      await panels.loadProject(last.project, last.path || '');
      S.dirty = !last.path; syncBar();
    }
  } catch (e) { /* no earlier session */ }
  window.kiteReady = true;
}
// lets the automated checks read the editor's state
window.kiteState = () => JSON.parse(JSON.stringify({ p: S.p, sel: S.sel, cut: S.cut, t: S.t, playing: S.playing, pps: S.pps, path: S.path, dirty: S.dirty }));
window.kitePlayers = () => player.players();
window.kiteSpec = () => exporter.buildSpec('', 22, 0).spec;
start();
