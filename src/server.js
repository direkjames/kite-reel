// A small web server that only this app can reach. It serves the editor screen and the media you import,
// and takes the editor's requests (read this file, export this project). Running it this way keeps every
// piece of editor logic in plain JavaScript that works the same inside the app and in a test browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('./engine');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
};
const LUT_N = 33;
const num = (v, lo, hi, fallback = lo) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback; };

/** The editor sends a look as 33x33x33 colours packed into bytes. FFmpeg wants the same thing as a text table. */
function cubeText(b64) {
  const bytes = Buffer.from(String(b64), 'base64');
  if (bytes.length !== LUT_N ** 3 * 3) throw new Error('bad look');
  const lines = ['TITLE "Kite Reel look"', `LUT_3D_SIZE ${LUT_N}`];
  for (let i = 0; i < bytes.length; i += 3) lines.push(`${(bytes[i] / 255).toFixed(5)} ${(bytes[i + 1] / 255).toFixed(5)} ${(bytes[i + 2] / 255).toFixed(5)}`);
  return lines.join('\n') + '\n';
}

function start({ version = '0.0.0', rendererDir = path.join(__dirname, '..', 'renderer'), dataDir = '' } = {}) {
  const token = crypto.randomBytes(16).toString('hex');   // other programs and web pages do not know this, so they get nothing
  const media = new Map();                                 // id -> file path, only for files the user chose
  const byPath = new Map();
  let port = 0;
  engine.sweepOld();

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  };
  const readJson = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 300e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
  const register = file => {
    if (byPath.has(file)) return byPath.get(file);
    const id = crypto.randomBytes(8).toString('hex'); media.set(id, file); byPath.set(file, id); return id;
  };
  const stateFile = dataDir ? path.join(dataDir, 'last-session.json') : '';

  function serveFile(req, res, file) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { send(res, 404, { error: 'missing' }); return; }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {               // players ask for pieces of the file so they can seek
        const from = range[1] ? +range[1] : Math.max(0, st.size - +range[2]);
        const to = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
        if (from > to || from >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
        res.writeHead(206, { ...head, 'content-range': `bytes ${from}-${to}/${st.size}`, 'content-length': to - from + 1 });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file, { start: from, end: to }).on('error', () => res.destroy()).pipe(res);
      } else {
        res.writeHead(200, { ...head, 'content-length': st.size });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }
    });
  }

  function exportSpec(body) {
    const fileOf = id => { const f = media.get(String(id || '')); if (!f) throw new Error('A file used in this project is no longer open. Import it again.'); return f; };
    const luts = (Array.isArray(body.luts) ? body.luts : []).map(cubeText);
    const width = Math.round(num(body.width, 16, 7680)), height = Math.round(num(body.height, 16, 7680));
    const duration = num(body.duration, 0, 86400, 0);
    if (!(duration > 0)) throw new Error('There is nothing on the timeline to export.');
    if (!body.outPath) throw new Error('Choose where to save first.');
    const layers = (Array.isArray(body.layers) ? body.layers : []).map(L => {
      const base = { type: L.type, start: num(L.start, 0, duration), dur: num(L.dur, 0.01, 86400, 0.01), x: num(L.x, -1e5, 1e5, 0), y: num(L.y, -1e5, 1e5, 0) };
      if (L.type === 'text') return { ...base, png: Buffer.from(String(L.png || ''), 'base64') };
      if (L.type !== 'video' && L.type !== 'image') throw new Error('Unknown layer.');
      return { ...base, file: fileOf(L.id), in: num(L.in, 0, 86400, 0), w: num(L.w, 2, 1e5), h: num(L.h, 2, 1e5), opacity: num(L.opacity, 0, 1, 1), lut: Number.isInteger(L.lut) && luts[L.lut] ? luts[L.lut] : '' };
    });
    const audio = (Array.isArray(body.audio) ? body.audio : []).map(A => ({
      file: A.layer >= 0 ? '' : fileOf(A.id), layer: Number.isInteger(A.layer) && A.layer >= 0 && A.layer < layers.length ? A.layer : -1,
      in: num(A.in, 0, 86400, 0), start: num(A.start, 0, duration), dur: num(A.dur, 0.01, 86400, 0.01),
      volume: num(A.volume, 0, 4, 1), fadeIn: num(A.fadeIn, 0, 600, 0), fadeOut: num(A.fadeOut, 0, 600, 0), mono: !!A.mono,
    }));
    for (const f of new Set([...layers.map(l => l.file), ...audio.map(a => a.file)].filter(Boolean))) {
      if (path.resolve(String(body.outPath)) === path.resolve(f)) throw new Error('Pick a different name so one of your original files is not overwritten.');
    }
    return { outPath: String(body.outPath), width, height, fps: Math.round(num(body.fps, 1, 120, 30)), duration, crf: Math.round(num(body.crf, 14, 35, 22)), outHeight: Math.round(num(body.outHeight, 0, 7680, 0)), layers, audio };
  }

  async function api(req, res, route) {
    if (route === 'info' && req.method === 'GET') return send(res, 200, { version });
    if (route === 'state' && req.method === 'GET') {
      try {
        const saved = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
        return send(res, 200, { project: saved ? saved.project : null, path: saved ? saved.path || '' : '' });
      } catch (e) { return send(res, 200, { project: null, path: '' }); }
    }
    const job = /^job\/([0-9a-f]+)(\/cancel)?$/.exec(route);
    if (job) {
      if (job[2] && req.method === 'POST') { engine.cancelJob(job[1]); return send(res, 200, { ok: true }); }
      const st = engine.jobStatus(job[1]);
      if (!st) return send(res, 404, { error: 'No such job.' });
      if (st.state === 'done' && st.result.file && !st.result.id) st.result.id = register(st.result.file);   // a finished preview copy becomes playable
      return send(res, 200, st);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Not allowed.' });
    const body = await readJson(req);
    if (route === 'open') {
      const file = String(body.path || '');
      if (!file || !fs.existsSync(file)) return send(res, 400, { error: 'That file is no longer there.' });
      try { return send(res, 200, { id: register(file), name: path.basename(file), path: file, ...(await engine.inspect(file)) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (route === 'state') {
      if (!stateFile) return send(res, 200, { ok: false });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ project: body.project || null, path: String(body.path || '') })); fs.renameSync(stateFile + '.tmp', stateFile);
      return send(res, 200, { ok: true });
    }
    if (route === 'project/save') {
      if (!body.path || !body.project) return send(res, 400, { error: 'Nothing to save.' });
      try { fs.writeFileSync(String(body.path), JSON.stringify({ app: 'Kite Reel', project: body.project }, null, 1)); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 400, { error: 'Kite Reel could not save there. Pick another folder.' }); }
    }
    if (route === 'project/open') {
      try {
        const data = JSON.parse(fs.readFileSync(String(body.path || ''), 'utf8'));
        if (!data || data.app !== 'Kite Reel' || !data.project) throw new Error('not ours');
        return send(res, 200, { project: data.project });
      } catch (e) { return send(res, 400, { error: 'That is not a Kite Reel project file.' }); }
    }
    if (route === 'export') {
      let spec;
      try { spec = exportSpec(body); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { job: engine.startExport(spec).id });
    }
    const input = media.get(String(body.id || ''));
    if (!input) return send(res, 400, { error: 'Import that file again.' });
    if (route === 'proxy') return send(res, 200, { job: engine.startProxy(input, +body.duration || 0).id });
    if (route === 'wave') {
      try { return send(res, 200, { id: register(await engine.waveform(input)) }); }
      catch (e) { return send(res, 400, { error: 'no waveform' }); }
    }
    return send(res, 404, { error: 'Unknown request.' });
  }

  const server = http.createServer((req, res) => {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { send(res, 403, { error: 'forbidden' }); return; }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.shift() !== token) { send(res, 403, { error: 'forbidden' }); return; }
    const route = parts.join('/');
    if (route.startsWith('api/')) { api(req, res, route.slice(4)).catch(() => send(res, 500, { error: 'Something went wrong inside Kite Reel.' })); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'Not allowed.' }); return; }
    if (parts[0] === 'media' && parts.length === 2) {
      const file = media.get(parts[1]);
      if (!file) { send(res, 404, { error: 'missing' }); return; }
      serveFile(req, res, file); return;
    }
    // the editor's own files
    const name = route === '' ? 'index.html' : route;
    if (!/^[\w.-]+$/.test(name)) { send(res, 404, { error: 'missing' }); return; }
    serveFile(req, res, path.join(rendererDir, name));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/${token}/`, port, token, close: () => { engine.cancelAll(); server.close(); engine.cleanUp(); } });
    });
  });
}

module.exports = { start, cubeText };
