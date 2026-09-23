'use strict';

// Hover screenshots: SSA values, instructions, library functions, labels and pointers.
// A 1200x900 window gives tall hovers room below them and keeps them clear of the status bar.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PNG } = require('pngjs');

module.exports = async (cap, vscode) => {
  const out = process.env.CAPTURE_OUT;

  // Scroll so `line` (0-based) is the first visible line: tall hovers then open downward.
  const top = async line => {
    vscode.window.activeTextEditor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    await cap.wait(300);
  };

  // VS Code caps a hover at 250 px and scrolls the rest. Grow the open hover to
  // its full content height. With `until`, first hide everything after the first
  // block whose text starts with it, so a very tall hover ends cleanly there.
  const expand = ({ until } = {}) => cap.evaluate(`(() => {
    const content = document.querySelector('.monaco-hover .monaco-hover-content');
    const until = ${JSON.stringify(until || '')};
    if (until) {
      const block = [...content.querySelectorAll('p, tr, li, pre, table')].find(e => e.textContent.trim().startsWith(until));
      if (!block) throw new Error('No hover block starts with ' + until);
      for (let e = block; e && e !== content; e = e.parentElement)
        for (let sibling = e.nextElementSibling; sibling; sibling = sibling.nextElementSibling) sibling.style.display = 'none';
    }
    content.scrollTop = 0;
    const height = content.scrollHeight;
    for (const e of [content, content.parentElement, content.closest('.monaco-hover'), content.closest('.monaco-resizable-hover')]) {
      e.style.height = height + 'px';
      e.style.maxHeight = height + 'px';
    }
    content.closest('.monaco-hover').querySelectorAll('.scrollbar').forEach(e => e.style.display = 'none');
    return height;
  })()`);

  // Widen a crop so that code lines inside it are not cut at the right edge.
  const wholeLines = async clip => {
    const spans = await cap.elements('.monaco-editor.focused .view-lines .view-line > span');
    const [ruler] = await cap.elements('.monaco-editor.focused .decorationsOverviewRuler');
    const right = Math.max(clip.x + clip.width, ...spans.filter(s => s.y >= clip.y - 1 && s.y + s.height <= clip.y + clip.height + 1).map(s => s.x + s.width + 16));
    // Stop short of the overview ruler, whose marks would show at the edge.
    return { ...clip, width: Math.min(ruler ? ruler.x - 2 : Infinity, Number(process.env.CAPTURE_WIDTH), Math.ceil(right)) - clip.x };
  };

  const hover = async (name, needle, options, { grow, until, lines = 1 } = {}) => {
    await cap.cursor(needle, options);
    await cap.hover();
    if (grow) await expand({ until });
    await cap.wait(200);
    const region = await wholeLines(await cap.region(['.monaco-resizable-hover', 'cursor-text'], { lines }));
    await cap.shot(name, { region });
    await cap.key('Escape');
    await cap.wait(200);
    shrink(`${name}.png`);
  };

  // Hovers open below the cursor; no overview ruler or scrollbar marks at the right edge.
  await cap.config({ 'editor.hover.above': false, 'editor.hideCursorInOverviewRuler': true, 'editor.overviewRulerBorder': false, 'editor.scrollbar.vertical': 'hidden' });
  await cap.open('main.ll');
  await hover('hover-variable', '%updated = add', { delta: 2 });
  await top(12);
  await hover('hover-instruction', 'icmp sge', { delta: 1 }, { grow: true });
  await top(43);
  await hover('hover-library', '@printf(ptr @summary', { delta: 2 }, { grow: true, until: '%s' });
  // Two blank lines after @sum_to (line numbers inside it are unchanged), so the
  // label hover's lower edge does not cover the half-visible `define @clamp` line.
  await vscode.window.activeTextEditor.edit(edit => edit.insert(new vscode.Position(24, 0), '\n\n'));
  await top(12);
  await hover('hover-label', 'label %body', { delta: 7 }, { grow: true });

  await cap.open('animals.ll');
  await hover('hover-pointer', '%method = load', { delta: 2 });
  await hover('hover-receiver', '%this', { delta: 2, occurrence: 2 });

  // Screenshots over 150 KiB are re-encoded as 256-colour palette PNGs (median
  // cut, no dithering): text on a flat dark theme survives this unchanged.
  function shrink(file) {
    const target = path.join(out, file), buffer = fs.readFileSync(target);
    if (buffer.length <= 150 * 1024) return;
    const result = quantize(buffer);
    fs.writeFileSync(target, result);
    console.log(`CAPTURED ${file} ${(result.length / 1024).toFixed(0)} KiB (palette)`);
  }
};

function quantize(buffer, colors = 256) {
  const { width, height, data } = PNG.sync.read(buffer);
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const c = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const channel = (c, shift) => (c >> shift) & 255;
  const spread = box => {
    let best = -1, shift = 0;
    for (const s of [16, 8, 0]) {
      let lo = 255, hi = 0;
      for (const [c] of box) { const v = channel(c, s); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo > best) { best = hi - lo; shift = s; }
    }
    return { best, shift };
  };
  const weight = box => box.reduce((sum, [, n]) => sum + n, 0);
  const boxes = [[...counts.entries()]];
  while (boxes.length < colors) {
    let pick = -1, score = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const value = spread(box).best * Math.sqrt(weight(box));
      if (value > score) { score = value; pick = i; }
    });
    if (pick < 0) break;
    const box = boxes[pick], { shift } = spread(box);
    box.sort((a, b) => channel(a[0], shift) - channel(b[0], shift));
    const total = weight(box);
    let sum = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { sum += box[i][1]; if (sum >= total / 2) { cut = i + 1; break; } }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette = boxes.map(box => {
    const total = weight(box);
    return [16, 8, 0].map(s => Math.round(box.reduce((sum, [c, n]) => sum + channel(c, s) * n, 0) / total));
  });
  const index = new Map();
  for (const c of counts.keys()) {
    let best = 0, distance = Infinity;
    palette.forEach((p, i) => {
      const d = (p[0] - channel(c, 16)) ** 2 + (p[1] - channel(c, 8)) ** 2 + (p[2] - channel(c, 0)) ** 2;
      if (d < distance) { distance = d; best = i; }
    });
    index.set(c, best);
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[y * (width + 1) + 1 + x] = index.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
  const chunk = (type, body) => {
    const head = Buffer.alloc(4), tail = Buffer.alloc(4), typed = Buffer.concat([Buffer.from(type), body]);
    head.writeUInt32BE(body.length);
    tail.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 3; // 8-bit indexed colour
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('PLTE', Buffer.from(palette.flat())), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports.window = { width: 1200, height: 900 };
