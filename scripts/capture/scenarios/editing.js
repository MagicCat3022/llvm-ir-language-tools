'use strict';

// Completion and editing GIFs: operand and label completion, signature help,
// cross-file completion that adds a declare, and rename.
// Set CAPTURE_ONLY=name1,name2 to capture a subset while iterating.

const only = (process.env.CAPTURE_ONLY || '').split(',').filter(Boolean);
const wanted = name => !only.length || only.includes(name);

module.exports = async (cap, vscode) => {
  const reset = async () => {
    await cap.command('workbench.action.revertAndCloseActiveEditor').catch(() => {});
    await cap.command('workbench.action.closeAllEditors');
    await cap.wait(300);
  };

  // Geometry of the editor text area and one line.
  const geometry = () => cap.evaluate(`(() => {
    const line = document.querySelector('.monaco-editor.focused .view-overlays .current-line');
    const editor = line.closest('.monaco-editor');
    const lines = editor.querySelector('.lines-content').getBoundingClientRect();
    const e = editor.getBoundingClientRect();
    const view = editor.querySelector('.view-lines .view-line').getBoundingClientRect();
    return { lineTop: line.getBoundingClientRect().top, lineHeight: view.height, left: e.left, right: e.right, top: e.top, bottom: e.bottom, textLeft: lines.left };
  })()`);

  // A region from `above` lines over the cursor line to `below` lines under it,
  // starting at the editor's left edge, `width` CSS px wide.
  const box = async (above, below, width) => {
    const g = await geometry();
    const top = Math.max(g.top, g.lineTop - above * g.lineHeight);
    const bottom = Math.min(g.bottom, g.lineTop + (below + 1) * g.lineHeight);
    return { x: Math.floor(g.left), y: Math.floor(top), width, height: Math.ceil(bottom - top) };
  };

  // Move the suggestion focus to the row whose label starts with `label`, then accept.
  const labels = () => cap.evaluate(`[...document.querySelectorAll('.suggest-widget .monaco-list-row')]
    .map(row => ({ label: row.querySelector('.label-name')?.textContent || row.getAttribute('aria-label') || '', index: Number(row.dataset.index), focused: row.classList.contains('focused') }))`);
  const pick = async (label, { key = 'Enter', step = 350 } = {}) => {
    await cap.waitFor('.suggest-widget .monaco-list-row');
    let rows = await labels();
    const target = rows.find(r => r.label === label) || rows.find(r => r.label.startsWith(label));
    if (!target) throw new Error(`No suggestion ${label}`);
    let focused = rows.find(r => r.focused)?.index ?? 0;
    while (focused !== target.index) {
      await cap.key(focused < target.index ? 'ArrowDown' : 'ArrowUp');
      await cap.wait(step);
      focused += focused < target.index ? 1 : -1;
    }
    await cap.wait(400);
    await cap.key(key);
  };

  // Scroll so that 0-based `line` is the top visible line; clear toasts.
  const top = async line => {
    const editor = vscode.window.activeTextEditor;
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    await cap.command('notifications.clearAll');
    await cap.wait(400);
  };

  // Type into the focused input (the rename box) like a user would.
  const typeInput = async (text, delay = 90) => {
    for (const character of text) {
      await cap.evaluate(`document.execCommand('insertText', false, ${JSON.stringify(character)})`);
      await cap.wait(delay);
    }
  };

  // Keep llvm-as squiggles from flashing while a line is half typed.
  await cap.config({ 'llvmIR.diagnostics.delay': 3000, 'editor.hideCursorInOverviewRuler': true });

  if (wanted('complete-operands')) {
    await cap.open('main.ll');
    await cap.cursor('  %next = add i32 %i, 1', { delta: 23 });
    await cap.command('editor.action.insertLineAfter');
    await top(10);
    const region = await box(8, 6, 760);
    await cap.record('complete-operands', async () => {
      await cap.wait(300);
      await cap.type('%double = add i32 %', { delay: 45 });
      await cap.wait(900);
      await pick('%updated', { step: 220 });
      await cap.type(', %', { delay: 45 });
      await cap.wait(400);
      await pick('%updated', { step: 100 });
      await cap.wait(400);
    }, { region });
    await reset();
  }

  if (wanted('complete-labels')) {
    await cap.open('main.ll');
    await cap.cursor('  br label %loop', { occurrence: 2, delta: 2, select: 14 });
    await cap.command('deleteLeft');
    await top(8);
    const region = await box(9, 5, 640);
    await cap.record('complete-labels', async () => {
      await cap.wait(300);
      await cap.type('br label %', { delay: 70 });
      await cap.wait(1200);
      await pick('%loop');
      await cap.wait(600);
    }, { region });
    await reset();
  }

  if (wanted('signature-help')) {
    // Inlay hints re-layout awkwardly (truncated with …) on a half-typed call.
    await cap.config({ 'llvmIR.inlayHints.enabled': false });
    await cap.open('main.ll');
    await cap.cursor('  %divisor = call i32 @gcd(i32 %bounded, i32 12)', { delta: 48 });
    await cap.command('editor.action.insertLineAfter');
    await top(34);
    const region = await box(6, 4, 760);
    await cap.record('signature-help', async () => {
      await cap.wait(300);
      await cap.type('%c = call i32 @clamp', { delay: 55 });
      await cap.key('Escape');
      await cap.type('(', { delay: 800 });
      for (const part of ['i32 5', ', ', 'i32 0', ', ', 'i32 9']) {
        await cap.type(part, { delay: 60 });
        await cap.wait(part === ', ' ? 600 : 100);
      }
      await cap.wait(500);
      await cap.key('Escape');
      await cap.command('cursorEnd');
      await cap.wait(400);
    }, { region });
    await reset();
    await cap.config({ 'llvmIR.inlayHints.enabled': true });
  }

  if (wanted('complete-cross-file')) {
    // Without CodeLens lines the declares and the edit fit in one short frame.
    await cap.config({ 'llvmIR.codeLens.references': false, 'llvmIR.codeLens.controlFlowGraph': false });
    await cap.open('main.ll');
    await cap.wait(2000);
    await cap.cursor('  %next = add i32 %i, 1', { delta: 23 });
    await cap.command('editor.action.insertLineAfter');
    await top(0);
    const g = await geometry();
    const region = { x: Math.floor(g.left), y: Math.floor(g.top), width: 800, height: Math.ceil(g.lineTop + 4 * g.lineHeight - g.top) };
    await cap.record('complete-cross-file', async () => {
      await cap.wait(300);
      await cap.type('%sq = call i32 @squ', { delay: 60 });
      await cap.wait(1300);
      await pick('@square');
      await cap.wait(900);
      await cap.type('(i32 %next)', { delay: 50 });
      await cap.wait(500);
    }, { region });
    await reset();
  }

  if (wanted('rename')) {
    await cap.config({ 'llvmIR.codeLens.references': false, 'llvmIR.codeLens.controlFlowGraph': false, 'llvmIR.inlayHints.enabled': false });
    await cap.open('math.ll', { column: vscode.ViewColumn.Two });
    await cap.open('main.ll', { column: vscode.ViewColumn.One });
    await cap.wait(2000);
    // Fold the two functions between the declares and @main so both uses fit.
    await cap.command('editor.fold', { levels: 1, selectionLines: [6, 25] });
    // Give main.ll's longer lines more room than math.ll's.
    for (let i = 0; i < 2; i++) await cap.command('workbench.action.increaseViewSize');
    await cap.cursor('@gcd(i32 %bounded', { delta: 2 });
    await top(3);
    // Both editors, from the tab bar to the last line of main.ll.
    const editors = await cap.region(['.editor-group-container'], { pad: 0 });
    const g = await geometry();
    const region = { x: editors.x, y: editors.y, width: editors.width, height: Math.ceil(g.lineTop + 4 * g.lineHeight - editors.y) };
    await cap.mouse(editors.x + 300, 690);   // park the pointer off the editors
    await cap.record('rename', async () => {
      await cap.wait(500);
      await cap.key('F2');
      await cap.waitFor('.rename-box');
      await cap.wait(800);
      await typeInput('euclid', 90);
      await cap.wait(600);
      await cap.key('Enter');
      await cap.wait(900);
    }, { region });
    await reset();
  }
};
