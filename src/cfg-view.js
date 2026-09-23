'use strict';

const analysis = require('./analysis');

const NODE_HEIGHT = 46, RANK_GAP = 64, NODE_GAP = 36, MARGIN = 24;
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A layered (Sugiyama-style) layout: back edges are found by DFS and drawn
// separately, long edges pass through virtual nodes so they do not cut
// through blocks, and barycenter sweeps reduce crossings.
function layoutGraph(graph, text) {
  const blocks = graph.blocks, count = blocks.length;
  const state = new Array(count).fill(0), back = new Set();
  const visit = start => {
    const stack = [[start, 0]];
    state[start] = 1;
    while (stack.length) {
      const frame = stack[stack.length - 1], [node] = frame;
      const next = blocks[node].successors[frame[1]++];
      if (next === undefined) { state[node] = 2; stack.pop(); continue; }
      if (state[next] === 1) back.add(`${node}>${next}`);
      else if (!state[next]) { state[next] = 1; stack.push([next, 0]); }
    }
  };
  for (let i = 0; i < count; i++) if (!state[i]) visit(i);

  const forward = [], backward = [];
  for (const block of blocks) for (const next of block.successors) (back.has(`${block.index}>${next}`) ? backward : forward).push([block.index, next]);
  const rank = new Array(count).fill(0), incoming = new Array(count).fill(0);
  for (const [, to] of forward) incoming[to]++;
  const queue = blocks.map(block => block.index).filter(i => !incoming[i]);
  while (queue.length) {
    const node = queue.shift();
    for (const [from, to] of forward) if (from === node) { rank[to] = Math.max(rank[to], rank[node] + 1); if (!--incoming[to]) queue.push(to); }
  }

  // Nodes: real blocks, then virtual nodes along edges that skip ranks.
  const nodes = blocks.map(block => {
    const detail = `${block.instructions} instr${block.terminator ? ` · ${block.terminator}` : ''}${block.backEdges?.length ? ' · loop' : ''}`;
    const name = block.name || `block ${block.index}`;
    return { index: block.index, name, detail, rank: rank[block.index], width: Math.max(96, 7.4 * Math.max(name.length, detail.length) + 28), reachable: block.reachable !== false,
      loop: !!block.backEdges?.length, preview: text.slice(block.start, block.end).trim().split(/\r?\n/).slice(0, 10).join('\n') };
  });
  const chains = forward.map(([from, to]) => {
    const chain = [from];
    for (let r = rank[from] + 1; r < rank[to]; r++) { nodes.push({ virtual: true, rank: r, width: 2 }); chain.push(nodes.length - 1); }
    chain.push(to);
    return { from, to, chain };
  });
  const ranks = [];
  nodes.forEach((node, i) => (ranks[node.rank] ||= []).push(i));
  const neighbors = nodes.map(() => ({ up: [], down: [] }));
  for (const { chain } of chains) for (let i = 1; i < chain.length; i++) { neighbors[chain[i]].up.push(chain[i - 1]); neighbors[chain[i - 1]].down.push(chain[i]); }
  const order = new Array(nodes.length);
  const renumber = () => ranks.forEach(row => row.forEach((node, i) => { order[node] = i; }));
  renumber();
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0;
    for (const row of down ? ranks.slice(1) : ranks.slice(0, -1).reverse()) {
      const center = node => { const list = down ? neighbors[node].up : neighbors[node].down; return list.length ? list.reduce((sum, n) => sum + order[n], 0) / list.length : order[node]; };
      row.sort((a, b) => center(a) - center(b) || order[a] - order[b]);
      row.forEach((node, i) => { order[node] = i; });
    }
  }

  // x: pull each node toward its parents' center, then remove overlaps.
  const x = new Array(nodes.length).fill(0);
  for (const row of ranks) {
    let cursor = 0;
    for (const node of row) { x[node] = cursor + nodes[node].width / 2; cursor += nodes[node].width + NODE_GAP; }
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const row of pass % 2 ? [...ranks].reverse() : ranks) {
      const want = row.map(node => {
        const list = [...neighbors[node].up, ...neighbors[node].down];
        return list.length ? list.reduce((sum, n) => sum + x[n], 0) / list.length : x[node];
      });
      row.forEach((node, i) => { x[node] = want[i]; });
      for (let i = 1; i < row.length; i++) {
        const min = x[row[i - 1]] + (nodes[row[i - 1]].width + nodes[row[i]].width) / 2 + NODE_GAP;
        if (x[row[i]] < min) x[row[i]] = min;
      }
      for (let i = row.length - 2; i >= 0; i--) {
        const max = x[row[i + 1]] - (nodes[row[i + 1]].width + nodes[row[i]].width) / 2 - NODE_GAP;
        if (x[row[i]] > max) x[row[i]] = max;
      }
    }
  }
  const left = Math.min(...nodes.map((node, i) => x[i] - node.width / 2));
  nodes.forEach((node, i) => { node.x = x[i] - left + MARGIN; node.y = MARGIN + node.rank * (NODE_HEIGHT + RANK_GAP) + NODE_HEIGHT / 2; });
  let right = Math.max(...nodes.map(node => node.x + node.width / 2));

  // Conditional branches label their edges T and F, like opt -dot-cfg.
  const branch = (from, to) => {
    const block = blocks[from];
    return block.terminator === 'br' && block.successors.length === 2 ? (block.successors[0] === to ? 'T' : 'F') : undefined;
  };
  const edges = chains.map(({ from, to, chain }) => ({ from, to, kind: 'forward', label: branch(from, to),
    points: chain.map((node, i) => [nodes[node].x, nodes[node].y + (i === 0 ? NODE_HEIGHT / 2 : i === chain.length - 1 ? -NODE_HEIGHT / 2 : 0)]) }));
  // Back edges leave the source's bottom, run right through the gap below it,
  // up a lane beside everything in between, and enter the target from above,
  // so their horizontal runs never cross a block.
  backward.forEach(([from, to], i) => {
    const source = nodes[from], target = nodes[to];
    const between = nodes.filter(node => node.rank >= Math.min(source.rank, target.rank) && node.rank <= Math.max(source.rank, target.rank));
    const lane = Math.max(...between.map(node => node.x + node.width / 2)) + 20 + 12 * i;
    const below = source.y + NODE_HEIGHT / 2 + RANK_GAP / 2 + 6 * i, above = target.y - NODE_HEIGHT / 2 - RANK_GAP / 3 - 6 * i;
    right = Math.max(right, lane);
    edges.push({ from, to, kind: 'back', label: branch(from, to), points: [
      [source.x + source.width / 4, source.y + NODE_HEIGHT / 2], [source.x + source.width / 4, below], [lane, below],
      [lane, above], [target.x + target.width / 4, above], [target.x + target.width / 4, target.y - NODE_HEIGHT / 2]] });
  });
  const height = MARGIN * 2 + ranks.length * (NODE_HEIGHT + RANK_GAP) - RANK_GAP + (backward.length ? RANK_GAP / 2 : 0);
  return { width: right + MARGIN, height, nodes: nodes.filter(node => !node.virtual), edges };
}

function edgePath(edge) {
  const [[x0, y0], ...rest] = edge.points;
  if (edge.kind === 'back') {
    // An orthogonal route with rounded corners.
    const points = edge.points;
    let path = `M${x0},${y0}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [px, py] = points[i - 1], [cx, cy] = points[i], [nx, ny] = points[i + 1];
      const r = Math.min(6, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
      const toward = (ax, ay, bx, by) => { const d = Math.hypot(bx - ax, by - ay) || 1; return [ax + (bx - ax) * r / d, ay + (by - ay) * r / d]; };
      const [ax, ay] = toward(cx, cy, px, py), [bx, by] = toward(cx, cy, nx, ny);
      path += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
    }
    const [lx, ly] = points[points.length - 1];
    return `${path} L${lx},${ly}`;
  }
  let path = `M${x0},${y0}`, previous = [x0, y0];
  for (const [x, y] of rest) {
    const middle = (previous[1] + y) / 2;
    path += ` C${previous[0]},${middle} ${x},${middle} ${x},${y}`;
    previous = [x, y];
  }
  return path;
}

// Self-contained page: theme CSS variables, no remote resources, and a nonce'd
// script that only posts block indexes back to the extension.
function renderGraph(layout, { title, cspSource, nonce, selected }) {
  const nodes = layout.nodes.map(node => `<g class="node${node.reachable ? '' : ' unreachable'}${node.loop ? ' loop' : ''}${node.index === selected ? ' selected' : ''}" data-index="${node.index}" transform="translate(${node.x - node.width / 2},${node.y - NODE_HEIGHT / 2})" tabindex="0" role="button" aria-label="${escape(`${node.name}, ${node.detail}`)}">
  <title>${escape(node.preview)}</title>
  <rect width="${node.width}" height="${NODE_HEIGHT}" rx="6"/>
  <text class="name" x="${node.width / 2}" y="19">${escape(node.name)}</text>
  <text class="detail" x="${node.width / 2}" y="36">${escape(node.detail)}</text>
</g>`).join('\n');
  const edges = layout.edges.map(edge => {
    // Branch labels sit just along the edge, on the side it leaves toward.
    const [[x0, y0], [x1]] = edge.points;
    const side = x1 < x0 - 1 ? -1 : x1 > x0 + 1 ? 1 : (edge.label === 'T' ? -1 : 1);
    const label = edge.label ? `<text class="edge-label" x="${x0 + side * 12}" y="${y0 + 14}">${edge.label}</text>` : '';
    return `<path class="edge ${edge.kind}" d="${edgePath(edge)}" marker-end="url(#arrow-${edge.kind})"/>${label}`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escape(title)}</title>
<style>
  body { margin: 0; padding: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  header { position: sticky; top: 0; padding: 6px 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-font-family); display: flex; gap: 16px; align-items: baseline; }
  header strong { font-family: var(--vscode-editor-font-family); }
  header span { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border)); stroke-width: 1; }
  .node { cursor: pointer; outline: none; }
  .node:hover rect, .node:focus-visible rect { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .node.selected rect { stroke: var(--vscode-llvmIR-labelForeground); stroke-width: 2.5; }
  .node.loop rect { stroke-dasharray: none; }
  .node.unreachable { opacity: 0.45; }
  .node text { text-anchor: middle; }
  .name { fill: var(--vscode-llvmIR-labelForeground); font-weight: bold; }
  .detail { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .edge { fill: none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.4; }
  .edge.back { stroke: var(--vscode-llvmIR-labelForeground); stroke-dasharray: 5 3; }
  .edge-label { fill: var(--vscode-descriptionForeground); font-size: 11px; font-weight: bold; }
  marker path { fill: var(--vscode-editorLineNumber-foreground); }
  #arrow-back path { fill: var(--vscode-llvmIR-labelForeground); }
  .empty { padding: 24px; font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); }
</style></head>
<body>
<header><strong>${escape(title)}</strong><span>Click a block to go to it · dashed edges loop back · T/F mark conditional branches</span></header>
${layout.nodes.length ? `<svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${escape(title)}">
<defs>
  <marker id="arrow-forward" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
  <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
</defs>
${edges}
${nodes}
</svg>` : '<p class="empty">This function has no blocks yet.</p>'}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const nodes = [...document.querySelectorAll('.node')];
  const select = index => nodes.forEach(node => node.classList.toggle('selected', Number(node.dataset.index) === index));
  for (const node of nodes) {
    const go = () => vscode.postMessage({ type: 'reveal', index: Number(node.dataset.index) });
    node.addEventListener('click', go);
    node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(); } });
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'select') return;
    select(event.data.index);
    const node = nodes.find(item => Number(item.dataset.index) === event.data.index);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
</script>
</body></html>`;
}

// One panel that follows the active LLVM IR editor's function and cursor.
function createGraphView(vscode, analyze) {
  let panel, current, timer;
  const nonce = () => Array.from({ length: 24 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
  const functionAt = (parsed, offset) => parsed.functions.find(fn => !fn.symbol.declaration && fn.bodyStart < fn.bodyEnd && offset >= fn.start && offset <= fn.end);
  function render(document, offset, force = false) {
    if (!panel || document.languageId !== 'llvm-ir') return;
    const parsed = analyze(document);
    const fn = functionAt(parsed, offset) || (current?.document === document && functionAt(parsed, current.start)) || parsed.functions.find(item => !item.symbol.declaration && item.bodyStart < item.bodyEnd);
    if (!fn) return;
    const graph = analysis.blockGraph(parsed, fn.bodyStart);
    const selected = graph.blockAt(Math.max(offset, fn.bodyStart)).index;
    const same = current && current.document === document && current.start === fn.start && current.version === document.version;
    if (same && !force) {
      if (current.selected !== selected) { current.selected = selected; void panel.webview.postMessage({ type: 'select', index: selected }); }
      return;
    }
    current = { document, start: fn.start, version: document.version, graph, selected };
    panel.title = `CFG: ${fn.name}`;
    panel.webview.html = renderGraph(layoutGraph(graph, parsed.text), { title: `${fn.name}`, cspSource: panel.webview.cspSource, nonce: nonce(), selected });
  }
  async function reveal(index) {
    const block = current?.graph.blocks[index];
    if (!block) return;
    const document = current.document;
    const target = block.label || { start: block.start, end: block.start };
    const range = new vscode.Range(document.positionAt(target.start), document.positionAt(target.end));
    const visible = vscode.window.visibleTextEditors.find(item => item.document === document);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One, selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  return {
    async show(uri, offset) {
      let editor = vscode.window.activeTextEditor;
      if (uri) editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preserveFocus: true });
      if (!editor || editor.document.languageId !== 'llvm-ir') return void vscode.window.showInformationMessage('Open an LLVM IR function to show its control-flow graph.');
      if (!panel) {
        panel = vscode.window.createWebviewPanel('llvmIR.controlFlowGraph', 'CFG', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
        panel.onDidDispose(() => { panel = undefined; current = undefined; });
        panel.webview.onDidReceiveMessage(message => { if (message?.type === 'reveal' && Number.isInteger(message.index)) void reveal(message.index); });
      } else panel.reveal(vscode.ViewColumn.Beside, true);
      current = undefined;
      render(editor.document, offset ?? editor.document.offsetAt(editor.selection.active), true);
    },
    follow(editor) { if (panel && editor) render(editor.document, editor.document.offsetAt(editor.selection.active)); },
    changed(document) {
      if (!panel || current?.document !== document) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const editor = vscode.window.visibleTextEditors.find(item => item.document === document);
        render(document, editor ? document.offsetAt(editor.selection.active) : current.start, true);
      }, 300);
    },
    dispose() { clearTimeout(timer); panel?.dispose(); }
  };
}

module.exports = { layoutGraph, renderGraph, createGraphView };
