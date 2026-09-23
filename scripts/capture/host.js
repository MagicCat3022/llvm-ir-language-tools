'use strict';

// Runs inside the VS Code extension host: drives the editor through the API
// and captures the window through the Chrome DevTools Protocol.
//
// Scenario API (`cap`):
//   await cap.open('file.ll')             open a workspace file in the editor
//   await cap.cursor('text', { delta, occurrence, select })   move the cursor to a match
//   await cap.type('text', { delay })     type characters (triggers completion)
//   await cap.command(id, ...args)        run a VS Code command
//   await cap.key('Escape' | 'Enter' | 'Tab' | 'ArrowDown', { ctrl, shift })
//   await cap.hover()                     show the hover at the cursor
//   await cap.point('text', { delta })    screen point {x, y} of a text position (moves the cursor)
//   await cap.elements(selector)          visible elements as [{ x, y, width, height, text }]
//   await cap.mouse(x, y)                 move the mouse (hover by pointer; inlay tooltips)
//   await cap.click(x, y, { count })      click, e.g. a CodeLens or a block in the graph
//   await cap.waitFor(selector)           wait until a visible element matches
//   await cap.wait(ms)
//   await cap.config({ 'llvmIR.x': value })   change settings for this run
//   await cap.region(around, { pad, lines })   rectangle around selectors or keywords
//   await cap.shot(name, { around, pad, lines, region })         write <name>.png
//   await cap.record(name, async () => {...}, { around, pad, lines, region, fps })  write <name>.gif
// `around` lists CSS selectors and the keywords 'cursor-text' (the text on the
// cursor's line), 'cursor-line' (that line, full width), 'editor' and 'window'.
// `lines: n` adds n editor lines above and below the cursor line, and snaps the
// top and bottom edges to line boundaries so no text is cut in half.
// Each GIF also writes its first, middle and last frames to .frames/ for review.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { PNG } = require('pngjs');
const { encodeGif } = require('./gif');

const env = process.env;
const out = env.CAPTURE_OUT, port = Number(env.CAPTURE_PORT);
const width = Number(env.CAPTURE_WIDTH), height = Number(env.CAPTURE_HEIGHT), scale = Number(env.CAPTURE_SCALE);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {}
    if (targets.some(target => target.type === 'page' && /workbench/.test(target.url))) break;
    await sleep(200);
  }
  const page = targets.find(target => target.type === 'page' && /workbench/.test(target.url));
  if (!page) throw new Error(`No VS Code workbench on DevTools port ${port}.`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = message.id !== undefined && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`)); else waiter.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}

function createCap(cdp) {
  const editor = () => {
    const active = vscode.window.activeTextEditor;
    if (!active) throw new Error('No active editor.');
    return active;
  };
  const evaluate = async expression => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const keywords = {
    // The active group's editor, whether or not it has focus (a hover or Escape can take it).
    'cursor-line': '.editor-group-container.active .monaco-editor .view-overlays .current-line',
    editor: '.editor-group-container.active .monaco-editor',
    window: 'body',
  };
  const keys = {
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, Space: { key: ' ', code: 'Space', keyCode: 32 },
    Period: { key: '.', code: 'Period', keyCode: 190 }, F2: { key: 'F2', code: 'F2', keyCode: 113 },
  };
  async function region(around = ['editor'], { pad = 16, lines } = {}) {
    const selectors = around.map(item => keywords[item] || item);
    const rect = await evaluate(`(() => {
      let box;
      const cursorText = () => {
        const line = document.querySelector(${JSON.stringify(keywords['cursor-line'])});
        if (!line) return [];
        const top = line.getBoundingClientRect().top;
        const editor = line.closest('.monaco-editor');
        return [...editor.querySelectorAll('.view-lines .view-line')].filter(view => Math.abs(view.getBoundingClientRect().top - top) < 2).map(view => view.firstElementChild || view);
      };
      for (const selector of ${JSON.stringify(selectors)}) {
        for (const element of selector === 'cursor-text' ? cursorText() : document.querySelectorAll(selector)) {
          const r = element.getBoundingClientRect(), style = getComputedStyle(element);
          if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') continue;
          box = box ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
            : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        }
      }
      if (box && ${lines === undefined ? 'false' : 'true'}) {
        const line = document.querySelector(${JSON.stringify(keywords['cursor-line'])});
        const current = line?.getBoundingClientRect();
        // The highlight can include a border; a text line has the exact line height.
        const height = line?.closest('.monaco-editor')?.querySelector('.view-lines .view-line')?.getBoundingClientRect().height;
        if (current && height) {
          const extra = ${Number(lines) || 0} * height;
          box.top = current.top - Math.ceil(Math.max(0, current.top - Math.min(box.top, current.top - extra)) / height) * height;
          box.bottom = current.bottom + Math.ceil(Math.max(0, Math.max(box.bottom, current.bottom + extra) - current.bottom) / height) * height;
          box.snapped = true;
        }
      }
      return box;
    })()`);
    if (!rect) throw new Error(`Nothing visible matches ${JSON.stringify(around)}.`);
    // Snapped edges already sit between lines; pad only the sides.
    if (rect.snapped) {
      const x = Math.max(0, Math.floor(rect.left - pad)), y = Math.max(0, Math.floor(rect.top));
      return { x, y, width: Math.min(width, Math.ceil(rect.right + pad)) - x, height: Math.min(height, Math.ceil(rect.bottom)) - y };
    }
    const x = Math.max(0, Math.floor(rect.left - pad)), y = Math.max(0, Math.floor(rect.top - pad));
    return { x, y, width: Math.min(width, Math.ceil(rect.right + pad)) - x, height: Math.min(height, Math.ceil(rect.bottom + pad)) - y };
  }
  const union = (...rects) => {
    const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
    return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
  };
  async function screenshot(clip, factor = 1) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: factor }, fromSurface: true });
    return Buffer.from(data, 'base64');
  }
  const written = [];
  const write = (file, data) => {
    fs.writeFileSync(path.join(out, file), data);
    written.push(file);
    console.log(`CAPTURED ${file} ${(data.length / 1024).toFixed(0)} KiB`);
  };

  const cap = {
    vscode, sleep, region, union, evaluate, written,
    wait: sleep,
    async open(file, { column } = {}) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const document = await vscode.workspace.openTextDocument(folder ? vscode.Uri.joinPath(folder.uri, file) : vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: column });
      await sleep(800);
      // "Extensions are temporarily disabled" can arrive after the start-up clear.
      await vscode.commands.executeCommand('notifications.clearAll');
      return vscode.window.activeTextEditor;
    },
    async cursor(needle, { delta = 0, occurrence = 1, select = 0 } = {}) {
      const active = editor(), text = active.document.getText();
      let offset = -1;
      for (let i = 0; i < occurrence; i++) offset = text.indexOf(needle, offset + 1);
      if (offset < 0) throw new Error(`Text not found: ${needle}`);
      const start = active.document.positionAt(offset + delta), end = active.document.positionAt(offset + delta + select);
      active.selection = new vscode.Selection(start, end);
      active.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      await sleep(250);
      return start;
    },
    async type(text, { delay = 90 } = {}) {
      for (const character of text) {
        await vscode.commands.executeCommand('type', { text: character });
        await sleep(delay);
      }
    },
    command: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    async key(name, { ctrl = false, shift = false, alt = false } = {}) {
      const key = keys[name] || { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0) };
      const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
      const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(150);
    },
    async waitFor(selector, { timeout = 5000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(`[...document.querySelectorAll(${JSON.stringify(keywords[selector] || selector)})].some(e => { const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).visibility !== 'hidden'; })`)) return;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${selector}.`);
    },
    async point(needle, options = {}) {
      await cap.cursor(needle, options);
      const [caret] = await cap.elements('.editor-group-container.active .monaco-editor .cursors-layer .cursor');
      if (!caret) throw new Error('No visible cursor.');
      return { x: caret.x + 1, y: caret.y + caret.height / 2 };
    },
    async elements(selector) {
      return evaluate(`[...document.querySelectorAll(${JSON.stringify(keywords[selector] || selector)})].map(e => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && getComputedStyle(e).visibility !== 'hidden' ? { x: r.left, y: r.top, width: r.width, height: r.height, text: e.textContent } : undefined;
      }).filter(Boolean)`);
    },
    async mouse(x, y) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(100);
    },
    async click(x, y, { count = 1 } = {}) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count });
      await sleep(300);
    },
    async hover() {
      await vscode.commands.executeCommand('editor.action.showHover');
      await cap.waitFor('.monaco-hover .hover-contents, .monaco-hover .rendered-markdown');
      await sleep(400);
    },
    async config(values) {
      const settings = vscode.workspace.getConfiguration();
      for (const [key, value] of Object.entries(values)) await settings.update(key, value, vscode.ConfigurationTarget.Global);
      await sleep(500);
    },
    // A still image, at the device scale factor (2 by default) for sharp text.
    async shot(name, { around, pad, lines, region: fixed } = {}) {
      const clip = fixed || await region(around, { pad, lines });
      // Capture the whole window and crop here: with an emulated viewport the
      // DevTools clip rectangle lands several pixels off.
      write(`${name}.png`, cropPng(await screenshot({ x: 0, y: 0, width, height }, 1), clip, scale));
      return clip;
    },
    // Frames are taken of the whole window during `action`, then cropped to the
    // region: `region`, or `around` as it is once the action has finished.
    async record(name, action, { around, pad, lines, region: fixed, fps = 10, factor = 0.5 } = {}) {
      const frames = [];
      let running = true, last = Date.now();
      const full = { x: 0, y: 0, width, height };
      const loop = (async () => {
        while (running) {
          const png = await screenshot(full, factor);
          const now = Date.now();
          if (frames.length) frames[frames.length - 1].delay = now - last;
          frames.push({ png, delay: 1000 / fps });
          last = now;
          await sleep(Math.max(0, 1000 / fps - (Date.now() - now)));
        }
      })();
      try { await action(); await sleep(300); } finally { running = false; await loop; }
      const clip = fixed || await region(around, { pad, lines });
      const cropped = frames.map(frame => ({ delay: frame.delay, png: cropPng(frame.png, clip, factor * scale) }));
      write(`${name}.gif`, encodeGif(cropped));
      fs.mkdirSync(path.join(out, '.frames'), { recursive: true });
      for (const [label, frame] of [['first', cropped[0]], ['middle', cropped[cropped.length >> 1]], ['last', cropped[cropped.length - 1]]])
        fs.writeFileSync(path.join(out, '.frames', `${name}.${label}.png`), frame.png);
      console.log(`  ${frames.length} frames, ${Math.round(clip.width)}x${Math.round(clip.height)}, ${(frames.reduce((sum, frame) => sum + frame.delay, 0) / 1000).toFixed(1)} s`);
      return clip;
    },
  };
  return cap;
}

function cropPng(buffer, clip, factor) {
  const image = PNG.sync.read(buffer);
  const x = Math.round(clip.x * factor), y = Math.round(clip.y * factor);
  const w = Math.min(image.width - x, Math.round(clip.width * factor)), h = Math.min(image.height - y, Math.round(clip.height * factor));
  const result = new PNG({ width: w, height: h });
  PNG.bitblt(image, result, x, y, w, h, 0, 0);
  return PNG.sync.write(result);
}

async function run() {
  const cdp = await connect();
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    // A clean window: only the editor, no side bars, panels or notifications.
    for (const command of ['workbench.action.closeSidebar', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar', 'notifications.clearAll']) {
      try { await vscode.commands.executeCommand(command); } catch {}
    }
    await sleep(1500);
    const scenario = require(env.CAPTURE_SCENARIO);
    const cap = createCap(cdp);
    await scenario(cap, vscode);
    console.log(`CAPTURE DONE: ${cap.written.join(', ') || 'nothing written'}`);
  } finally {
    cdp.close();
  }
}

module.exports = { run };
