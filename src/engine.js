// Everything that talks to FFmpeg: reading a file's details, making preview copies and waveforms, and exporting.
// Plain Node with no Electron in it, so it can be tested on its own.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function ffmpegPath() {
  if (process.env.KITE_FFMPEG) return process.env.KITE_FFMPEG;
  try {
    const p = require('ffmpeg-static');
    if (p) {
      // inside the installed app the program sits next to the packed code, not inside it
      const unpacked = p.replace('app.asar', 'app.asar.unpacked');
      return fs.existsSync(unpacked) ? unpacked : p;
    }
  } catch (e) { /* not installed: fall back to an ffmpeg on the PATH */ }
  return 'ffmpeg';
}

const workDir = path.join(os.tmpdir(), `kite-reel-${process.pid}`);
const rand = () => crypto.randomBytes(6).toString('hex');
function ensureWorkDir() { fs.mkdirSync(workDir, { recursive: true }); return workDir; }
function cleanUp() { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
/** Removes working folders left behind by earlier runs that could not tidy up, such as after a crash. */
function sweepOld() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^kite-reel-\d+$/.test(name)) continue;
      const dir = path.join(os.tmpdir(), name);
      if (dir !== workDir && Date.now() - fs.statSync(dir).mtimeMs > 24 * 3600 * 1000) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) { /* best effort */ }
}

/** Runs FFmpeg to the end and resolves with what it printed. */
function run(args, cwd) {
  return new Promise((resolve, reject) => {
    let text = '';
    const p = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
    p.stderr.on('data', d => { text = (text + d).slice(-200000); });
    p.on('error', () => reject(new Error('Kite Reel could not start its video engine.')));
    p.on('close', code => resolve({ code, text }));
  });
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const isJpeg = file => /\.jpe?g$/i.test(file);
/**
 * Phones often store a photo on its side, with a note saying which way up it goes. This reads that note from a JPEG:
 * 1 means as stored, 2 to 8 are the turns and flips (5 and above stand the picture on its side).
 */
function photoTurn(file) {
  try {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(131072), n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (n < 4 || buf.readUInt16BE(0) !== 0xFFD8) return 1;
    for (let p = 2; p + 4 <= n && buf[p] === 0xFF;) {
      const marker = buf[p + 1], size = buf.readUInt16BE(p + 2);
      if (marker === 0xDA) return 1;                               // the picture itself starts here: no note
      if (marker === 0xE1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
        const t = p + 10, little = buf.toString('latin1', t, t + 2) === 'II';
        const u16 = o => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o)), u32 = o => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const list = t + u32(t + 4), count = u16(list);
        for (let k = 0; k < count && list + 14 + k * 12 <= n; k++) {
          const e = list + 2 + k * 12;
          if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      p += 2 + size;
    }
  } catch (e) { /* unreadable: treat it as stored the right way up */ }
  return 1;
}
const TURNS = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
/** Works out whether a file is a video, a photo or a sound, and reads its length, size and frame rate. */
async function inspect(file) {
  const { text } = await run(['-hide_banner', '-i', file]);
  const lines = text.split(/\r?\n/);
  const videoLine = lines.find(l => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
  const audioLine = lines.find(l => /Stream #.*Audio:/.test(l));
  const hasAudio = !!audioLine, mono = !!audioLine && /,\s*(mono|1 channels)\b/.test(audioLine);
  const dur = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0;
  if (!videoLine) {
    if (hasAudio && duration > 0) return { kind: 'audio', duration, width: 0, height: 0, fps: 0, hasAudio: true, mono, codec: '' };
    throw new Error('Kite Reel cannot use that file. Try a video, a photo or a sound file.');
  }
  const size = videoLine.match(/,\s*(\d{1,5})x(\d{1,5})[\s,\[]/);
  const fps = videoLine.match(/([\d.]+)\s*fps/) || videoLine.match(/([\d.]+)\s*tbr/);
  const rot = text.match(/rotation of (-?[\d.]+) degrees/);
  let width = size ? +size[1] : 0, height = size ? +size[2] : 0;
  if (isJpeg(file) ? photoTurn(file) >= 5 : rot && Math.abs(Math.round(+rot[1])) % 180 === 90) [width, height] = [height, width];   // phone clips and photos taken upright
  if (!width || !height) throw new Error('Kite Reel could not read the size of that file.');
  const codec = (videoLine.match(/Video:\s*([^\s,(]+)/) || [])[1] || '';
  if (IMAGE_EXT.has(path.extname(file).toLowerCase())) return { kind: 'image', duration: 0, width, height, fps: 0, hasAudio: false, mono: false, codec };
  if (!(duration > 0)) throw new Error('That video has no length Kite Reel can read.');
  return { kind: 'video', duration, width, height, fps: fps ? +fps[1] : 30, hasAudio, mono, codec };
}

/* ---------- jobs: long FFmpeg runs with progress and cancel ---------- */
const jobs = new Map();

function startJob(args, { cwd, seconds, outPath, result }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, state: 'running', progress: 0, error: '', result: result || {}, outPath };
  jobs.set(id, job);
  let tail = '', buf = '';
  const p = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
  job.proc = p;
  p.stdout.on('data', d => {            // -progress pipe:1 writes key=value lines
    buf += d;
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && seconds > 0) job.progress = Math.max(job.progress, Math.min(0.999, +m[1] / 1e6 / seconds));
    }
  });
  p.stderr.on('data', d => { tail = (tail + d).slice(-3000); });
  p.on('error', () => { job.state = 'error'; job.error = 'Kite Reel could not start its video engine.'; });
  p.on('close', code => {
    if (job.state === 'cancelled') { if (outPath) fs.rm(outPath, { force: true }, () => {}); return; }
    if (code === 0) { job.state = 'done'; job.progress = 1; return; }
    if (job.state === 'error') return;
    job.state = 'error';
    job.error = /No space left/i.test(tail) ? 'The disk is full.'
      : /Permission denied/i.test(tail) ? 'Kite Reel is not allowed to save there. Pick another folder.'
      : /Error opening output/i.test(tail) ? 'Kite Reel could not save to that place. Pick another folder.'
      : 'The video engine stopped with an error.';
    job.detail = tail.trim().split(/\r?\n/).slice(-5).join('\n');
    if (outPath) fs.rm(outPath, { force: true }, () => {});
  });
  return job;
}
function jobStatus(id) {
  const j = jobs.get(id);
  return j ? { state: j.state, progress: j.progress, error: j.error, detail: j.detail || '', result: j.result, outPath: j.outPath || '' } : null;
}
function cancelJob(id) {
  const j = jobs.get(id);
  if (j && j.state === 'running') { j.state = 'cancelled'; try { j.proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }   // stop at once; the half-written file is deleted when it exits
}
function cancelAll() { for (const id of jobs.keys()) cancelJob(id); }

/* ---------- preview copy, for formats the app's built-in player cannot show ---------- */
function proxyArgs(input, output, format) {
  const common = ['-hide_banner', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', "scale=-2:'min(720,ih)',format=yuv420p"];
  const codec = format === 'webm'
    ? ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1500k', '-g', '15', '-c:a', 'libvorbis', '-b:a', '128k']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '15', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  return [...common, ...codec, '-progress', 'pipe:1', '-nostats', output];
}
function startProxy(input, seconds) {
  const format = process.env.KITE_PROXY === 'webm' ? 'webm' : 'mp4';
  const out = path.join(ensureWorkDir(), `preview-${rand()}.${format}`);
  return startJob(proxyArgs(input, out, format), { seconds, result: { file: out } });
}

/** Draws a sound's loudness over time as a picture, for showing inside clips on the timeline. */
async function waveform(input) {
  const out = path.join(ensureWorkDir(), `wave-${rand()}.png`);
  const { code } = await run(['-hide_banner', '-y', '-i', input, '-filter_complex',
    '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=2400x96:colors=white:scale=sqrt[w]', '-map', '[w]', '-frames:v', '1', out]);
  if (code !== 0 || !fs.existsSync(out)) throw new Error('no waveform');
  return out;
}

/* ---------- export ---------- */
const n3 = v => (+v).toFixed(3);
const even = v => Math.max(2, Math.round(v / 2) * 2);

/** FFmpeg's speed filter for sound only takes steps between half and double, so bigger changes are done in several steps. */
function tempo(speed) {
  const steps = []; let left = speed;
  while (left > 2.0001) { steps.push('atempo=2.0'); left /= 2; }
  while (left < 0.4999) { steps.push('atempo=0.5'); left /= 0.5; }
  if (Math.abs(left - 1) > 1e-4) steps.push(`atempo=${left.toFixed(5)}`);
  return steps;
}

/**
 * Turns a project into one FFmpeg run.
 * spec: { outPath, width, height, fps, duration, crf, outHeight (0 keeps the project size),
 *         layers: bottom to top, each one of
 *           { type: 'video', file, in, len, speed, padStart, padEnd, ...place, ...looks }
 *           { type: 'image', file, ...place, ...looks }
 *           { type: 'text',  png (Buffer), x, y, ...looks }
 *         audio: [{ file, in, len, speed, start, dur, volume, fadeIn, fadeOut, mono, layer }]   layer: index of the video layer whose sound this is, or -1 }
 *   place: x, y, w, h (where it goes in the frame), rot (0, 90, 180 or 270), flip, crop [left, top, right, bottom] as fractions,
 *          opacity, lut (a .cube colour table as text, or '')
 *   looks: start and dur (when it is on screen), fadeIn, fadeOut, whiteIn, whiteOut (seconds, at its two ends),
 *          patch ({ x, y, w, h, dur }: a part that stays solid over the last dur seconds while the rest fades out)
 *   For a video, in and len say which stretch of the file to read (in the file's own seconds) and speed how fast to play it;
 *   padStart and padEnd hold its first and last frame for that long.
 * Every layer becomes an input, is moved to its place on the timeline, and is stacked onto a black background.
 * Small files (colour tables, text pictures, the recipe itself) are written into `dir`, and FFmpeg runs from there,
 * so they can be named plainly without escaping Windows paths.
 */
function buildExport(spec, dir) {
  const inputs = [], graph = [], total = Math.max(0.05, +spec.duration), fps = spec.fps;
  const add = (...args) => { inputs.push(...args); return inputs.filter(a => a === '-i').length - 1; };
  const layerInput = [];
  graph.push(`color=c=black:s=${spec.width}x${spec.height}:r=${fps}:d=${n3(total)}[bg0]`);
  let last = 'bg0', step = 0;
  const stack = (name, x, y, from, to) => {
    graph.push(`[${last}][${name}]overlay=x=${x}:y=${y}:enable='gte(t,${n3(from)})*lt(t,${n3(to)})':eof_action=pass[bg${++step}]`);
    last = `bg${step}`;
  };
  spec.layers.forEach((L, k) => {
    const end = L.start + L.dur, chain = [];
    let i;
    if (L.type === 'video') {
      i = add('-ss', n3(L.in), '-t', n3(L.len), '-i', L.file);
      if (Math.abs(L.speed - 1) > 1e-4) chain.push(`setpts=(PTS-STARTPTS)/${L.speed.toFixed(5)}`);
      // holds the first frame for a lead-in, and the last for a lead-out (plus a moment more, in case the file ends a frame early)
      chain.push(`fps=${fps}`, `tpad=start_mode=clone:start_duration=${n3(L.padStart)}:stop_mode=clone:stop_duration=${n3(L.padEnd + 0.5)}`);
    } else {
      if (L.type === 'image') {
        // a phone photo is turned the right way up here, by its own note, so every FFmpeg version shows it as the preview does
        const turn = isJpeg(L.file) ? photoTurn(L.file) : 0;
        i = add(...(turn ? ['-noautorotate'] : []), '-loop', '1', '-framerate', String(fps), '-t', n3(L.dur), '-i', L.file);
        chain.push(`fps=${fps}`);
        if (TURNS[turn]) chain.push(TURNS[turn]);
      } else {
        fs.writeFileSync(path.join(dir, `text${k}.png`), L.png);
        i = add('-loop', '1', '-framerate', String(fps), '-t', n3(L.dur), '-i', `text${k}.png`);
        chain.push(`fps=${fps}`);
      }
    }
    layerInput[k] = i;
    const X = Math.round(L.x), Y = Math.round(L.y);
    let W = 0, H = 0, rgb = false, alpha = L.type === 'text';
    if (L.type !== 'text') {
      W = even(L.w); H = even(L.h);
      if (L.rot === 90) chain.push('transpose=1'); else if (L.rot === 180) chain.push('hflip', 'vflip'); else if (L.rot === 270) chain.push('transpose=2');
      if (L.flip) chain.push('hflip');
      const [cl, ct, cr, cb] = L.crop;
      if (cl + ct + cr + cb > 1e-4) chain.push(`crop=w=iw*${(1 - cl - cr).toFixed(5)}:h=ih*${(1 - ct - cb).toFixed(5)}:x=iw*${cl.toFixed(5)}:y=ih*${ct.toFixed(5)}`);
      chain.push(`scale=${W}:${H}:flags=bicubic`, 'setsar=1');
      if (L.lut) { fs.writeFileSync(path.join(dir, `look${k}.cube`), L.lut); chain.push('format=rgb24', `lut3d=file=look${k}.cube:interp=tetrahedral`); rgb = true; }
    } else chain.push('format=rgba');
    // a flash: out of white at the start, into white at the end
    if (L.whiteIn > 0.01 || L.whiteOut > 0.01) {
      if (!rgb && !alpha) chain.push('format=rgb24');
      if (L.whiteIn > 0.01) chain.push(`fade=t=in:st=0:d=${n3(L.whiteIn)}:color=white`);
      if (L.whiteOut > 0.01) chain.push(`fade=t=out:st=${n3(L.dur - L.whiteOut)}:d=${n3(L.whiteOut)}:color=white`);
    }
    // see-through: a set opacity, and fades at either end
    const patch = L.patch && L.fadeOut > 0.01 ? L.patch : null;
    if (L.type !== 'text' && (L.opacity < 0.999 || L.fadeIn > 0.01 || L.fadeOut > 0.01)) { chain.push('format=rgba'); alpha = true; }
    if (L.type !== 'text' && L.opacity < 0.999) chain.push(`colorchannelmixer=aa=${n3(Math.max(0, L.opacity))}`);
    if (L.fadeIn > 0.01) chain.push(`fade=t=in:st=0:d=${n3(L.fadeIn)}:alpha=1`);
    const fadeOut = L.fadeOut > 0.01 ? `fade=t=out:st=${n3(L.dur - L.fadeOut)}:d=${n3(L.fadeOut)}:alpha=1` : '';
    const place = `setpts=PTS-STARTPTS+${n3(L.start)}/TB`;
    if (patch) {
      // the part of this layer that the next clip dissolves in over stays solid, while the rest of it fades away
      const px = Math.max(0, Math.round(patch.x) - X), py = Math.max(0, Math.round(patch.y) - Y);
      const pw = Math.max(2, Math.min(Math.round(patch.w), W - px)), ph = Math.max(2, Math.min(Math.round(patch.h), H - py)), from = L.dur - patch.dur;
      graph.push(`[${i}:v:0]${chain.join(',')},split[m${k}][p${k}]`);
      graph.push(`[m${k}]${fadeOut},${place}[v${k}]`);
      graph.push(`[p${k}]trim=start=${n3(from)},crop=${pw}:${ph}:${px}:${py},setpts=PTS-STARTPTS+${n3(L.start + from)}/TB[q${k}]`);
      stack(`v${k}`, X, Y, L.start, end);
      stack(`q${k}`, X + px, Y + py, L.start + from, end);
    } else {
      if (fadeOut) chain.push(fadeOut);
      chain.push(place);
      graph.push(`[${i}:v:0]${chain.join(',')}[v${k}]`);
      stack(`v${k}`, X, Y, L.start, end);
    }
  });
  const outH = spec.outHeight > 0 && spec.outHeight < spec.height ? even(spec.outHeight) : 0;
  graph.push(`[${last}]${outH ? `scale=-2:${outH}:flags=bicubic,` : ''}format=yuv420p[vout]`);

  const mixed = [];
  spec.audio.forEach((A, k) => {
    const i = A.layer >= 0 ? layerInput[A.layer] : add('-ss', n3(A.in), '-t', n3(A.len), '-i', A.file);
    const chain = ['aresample=48000', ...tempo(A.speed)];
    if (A.mono) chain.push('pan=stereo|c0=c0|c1=c0');      // a one-channel sound plays at full level from both speakers
    chain.push('aformat=sample_fmts=fltp:channel_layouts=stereo', `atrim=0:${n3(A.dur)}`, `volume=${n3(Math.max(0, A.volume))}`);
    if (A.fadeIn > 0.01) chain.push(`afade=t=in:st=0:d=${n3(Math.min(A.fadeIn, A.dur))}`);
    if (A.fadeOut > 0.01) { const d = Math.min(A.fadeOut, A.dur); chain.push(`afade=t=out:st=${n3(A.dur - d)}:d=${n3(d)}`); }
    chain.push(`adelay=${Math.round(A.start * 1000)}:all=1`);
    graph.push(`[${i}:a:0]${chain.join(',')}[a${k}]`);
    mixed.push(`[a${k}]`);
  });
  if (mixed.length) graph.push(`${mixed.join('')}${mixed.length > 1 ? `amix=inputs=${mixed.length}:normalize=0:dropout_transition=0,` : ''}alimiter=limit=0.97:level=0,apad=whole_dur=${n3(total)}[aout]`);

  fs.writeFileSync(path.join(dir, 'recipe.txt'), graph.join(';\n') + '\n');
  const args = ['-hide_banner', '-y', ...inputs, '-filter_complex_script', 'recipe.txt', '-map', '[vout]'];
  if (mixed.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(spec.crf), '-r', String(fps), '-t', n3(total),
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', spec.outPath);
  return args;
}
function startExport(spec) {
  const dir = path.join(ensureWorkDir(), `export-${rand()}`);
  fs.mkdirSync(dir, { recursive: true });
  return startJob(buildExport(spec, dir), { cwd: dir, seconds: Math.max(0.05, +spec.duration), outPath: spec.outPath });
}

module.exports = { ffmpegPath, inspect, photoTurn, startProxy, proxyArgs, waveform, buildExport, startExport, jobStatus, cancelJob, cancelAll, cleanUp, sweepOld, workDir };
