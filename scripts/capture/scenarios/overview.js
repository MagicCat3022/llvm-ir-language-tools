'use strict';
// Overview + control-flow graph captures, in a 1300x860 window: the graph click
// below uses window coordinates measured at that size.

// Park the cursor on a line without scrolling, and unfocus the editor so the
// caret and active line number fade.
async function park(cap, vscode, line) {
  const editor = vscode.window.activeTextEditor;
  editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
  await cap.evaluate('document.activeElement && document.activeElement.blur()');
  await cap.wait(500);
}

// Rectangle covering editor lines `from`..`to` (1-based), snapped to line
// boundaries, with `above`/`below` extra lines. Moves the cursor.
async function lineRect(cap, vscode, from, to, { above = 0, below = 0 } = {}) {
  await cap.config({ 'editor.renderLineHighlight': 'line' });
  await cap.command('workbench.action.focusActiveEditorGroup');
  const editor = vscode.window.activeTextEditor;
  const rects = [];
  for (let line = from; line <= to; line++) {
    editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
    await cap.wait(60);
    if (!editor.document.lineAt(line - 1).text.trim()) continue; // empty lines have no text box
    const lines = line === from ? above : line === to ? below : 0;
    rects.push(await cap.region(['cursor-text'], { lines, pad: 0 }));
  }
  await cap.config({ 'editor.renderLineHighlight': 'none' });
  return cap.union(...rects);
}

const quiet = {
  'editor.renderLineHighlight': 'none',
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.matchBrackets': 'never',
  'editor.hideCursorInOverviewRuler': true,
  'editor.overviewRulerBorder': false,
  'editor.scrollbar.vertical': 'hidden',
  // No shadow along the top edge when the editor is scrolled.
  'workbench.colorCustomizations': { 'scrollbar.shadow': '#00000000' },
};

module.exports = async (cap, vscode) => {
  await cap.open('main.ll');
  await cap.command('notifications.clearAll');
  await cap.wait(2000);
  const editorBox = (await cap.elements('.editor-group-container.active .monaco-editor'))[0];
  const left = Math.round(editorBox.x) + 4;

  // 1. Hero: @sum_to with its CodeLens, hints and colors.
  await cap.command('revealLine', { lineNumber: 4, at: 'top' });
  await cap.wait(300);
  const hero = await lineRect(cap, vscode, 7, 24, { above: 2, below: 1 });
  await cap.config(quiet);
  await park(cap, vscode, 5);
  await cap.shot('overview', { region: { x: left, y: hero.y + 3, width: 780, height: hero.height - 3 } });

  // 2. Parameter-name hints on the calls in @main.
  await cap.command('revealLine', { lineNumber: 37, at: 'top' });
  await cap.wait(300);
  const main = await lineRect(cap, vscode, 40, 47, { above: 2, below: 1 });
  await park(cap, vscode, 38);
  await cap.shot('inlay-parameters', { region: { x: left, y: main.y, width: Math.max(700, main.x + main.width + 24 - left), height: main.height } });

  // 3. Control-flow graph: open it from the CodeLens, then follow the cursor
  // through the blocks and click blocks in the graph to jump the editor.
  await cap.config({ 'editor.renderLineHighlight': 'line' });
  await cap.command('workbench.action.focusActiveEditorGroup');
  await cap.command('revealLine', { lineNumber: 5, at: 'top' });
  vscode.window.activeTextEditor.selection = new vscode.Selection(6, 0, 6, 0);
  await cap.wait(600);
  const lens = (await cap.elements('.codelens-decoration a')).find(a => /Control-flow/.test(a.text) && a.y < 200);
  // The %exit block in the graph, in window coordinates (the webview is an
  // iframe, so its nodes are not in the workbench DOM). The layout is fixed.
  const exitBlock = [912, 361];
  await cap.record('cfg', async () => {
    await cap.wait(900);
    await cap.click(lens.x + lens.width / 2, lens.y + lens.height / 2);
    await cap.mouse(560, 600); // off the CodeLens, so it drops its hover color
    await cap.wait(1800);
    for (const label of ['loop:', 'body:']) { await cap.cursor(label); await cap.wait(1200); }
    // Clicking a block selects its label in the editor.
    await cap.click(...exitBlock);
    await cap.wait(2000);
  }, { region: { x: 52, y: 31, width: 1010, height: 490 } });

  // 4. Folding basic blocks: each label stays visible as the block's header.
  await cap.command('workbench.action.closeEditorsInOtherGroups');
  await cap.command('workbench.action.focusActiveEditorGroup');
  await cap.command('revealLine', { lineNumber: 4, at: 'top' });
  await cap.wait(600);
  const fold = await lineRect(cap, vscode, 7, 24, { above: 2, below: 1 });
  await cap.config({ 'editor.renderLineHighlight': 'line', 'editor.showFoldingControls': 'always' });
  vscode.window.activeTextEditor.selection = new vscode.Selection(6, 0, 6, 0);
  await cap.wait(400);
  await cap.record('folding', async () => {
    await cap.wait(900);
    for (const label of ['loop:', 'body:', 'exit:']) { await cap.cursor(label); await cap.wait(400); await cap.command('editor.fold'); await cap.wait(900); }
    await cap.wait(600);
    await cap.command('editor.unfoldAll');
    await cap.wait(1200);
  }, { region: { x: left - 4, y: fold.y, width: 720, height: fold.height } });
};

module.exports.window = { width: 1300, height: 860 };
