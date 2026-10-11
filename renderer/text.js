// Draws a text layer. The preview and the export both use this one function, so they always match.
export const FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Impact', 'Trebuchet MS', 'Times New Roman', 'Courier New', 'Comic Sans MS'];
const measure = document.createElement('canvas').getContext('2d');
const cache = new Map();

export const textKey = (c, cw, ch) => JSON.stringify([c.text, c.font, c.size, c.color, c.bold, c.align, c.outline, c.bg, c.bgColor, cw, ch]);

/**
 * Returns { canvas, x, y, w, h }: the text drawn on a snug canvas, and where that canvas sits in a frame of cw by ch pixels.
 * Size is a fraction of the frame's height; x and y are the offset of the text's centre from the frame's centre, as fractions.
 */
export function drawText(c, cw, ch) {
  const key = textKey(c, cw, ch);
  let hit = cache.get(key);
  if (!hit) {
    const px = Math.max(6, c.size * ch), font = `${c.bold ? 700 : 400} ${px}px "${c.font}", "Segoe UI", "Arial", sans-serif`;
    const lines = String(c.text || ' ').split('\n').map(l => l || ' ');
    measure.font = font;
    const widths = lines.map(l => measure.measureText(l).width), tw = Math.max(1, ...widths);
    const lineH = px * 1.22, pad = px * (c.bg ? 0.34 : 0.16), stroke = c.outline ? px * 0.11 : 0;
    const w = Math.ceil(tw + pad * 2 + stroke), h = Math.ceil(lineH * lines.length + pad * 2 + stroke);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const x = canvas.getContext('2d');
    if (c.bg) { x.fillStyle = c.bgColor; x.globalAlpha = 0.78; x.beginPath(); x.roundRect(0, 0, w, h, px * 0.22); x.fill(); x.globalAlpha = 1; }
    x.font = font; x.textBaseline = 'middle'; x.lineJoin = 'round';
    lines.forEach((line, i) => {
      const lx = c.align === 'left' ? pad + stroke / 2 : c.align === 'right' ? w - pad - stroke / 2 - widths[i] : (w - widths[i]) / 2;
      const ly = pad + stroke / 2 + lineH * (i + 0.5);
      if (stroke) { x.strokeStyle = 'rgba(0,0,0,.88)'; x.lineWidth = stroke; x.strokeText(line, lx, ly); }
      x.fillStyle = c.color; x.fillText(line, lx, ly);
    });
    hit = { canvas, w, h };
    cache.set(key, hit);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
  }
  return { canvas: hit.canvas, w: hit.w, h: hit.h, x: cw / 2 + c.x * cw - hit.w / 2, y: ch / 2 + c.y * ch - hit.h / 2 };
}
