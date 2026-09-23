// Diagnostics, quick fixes and the language status items, on mistakes.ll.
module.exports = async (cap, vscode) => {
  const editor = await cap.open('mistakes.ll');
  // Let the llvm-as probe and the workspace index finish before the status popup.
  await cap.wait(4000);
  await cap.command('notifications.clearAll');

  // status.png: the {} language-status popup with the index and toolchain items.
  const [status] = await cap.elements('#status\\.languageStatus');
  await cap.click(status.x + status.width / 2, status.y + status.height / 2);
  await cap.waitFor('.monaco-hover.workbench-hover');
  await cap.wait(600);
  const [popup] = await cap.elements('.monaco-hover.workbench-hover');
  const statusLeft = Math.min(popup.x, status.x) - 24;
  await cap.shot('status', { region: { x: statusLeft, y: popup.y - 16, width: 1100 - statusLeft, height: 700 - (popup.y - 16) } });
  await cap.key('Escape');

  // The rest shows the built-in checks (what mistakes.ll demonstrates): with llvm-as
  // on, its terser "use of undefined value" replaces "Did you mean %sum?".
  // CodeLenses off so all three functions fit in one screenshot.
  await cap.config({ 'llvmIR.diagnostics.enabled': false, 'llvmIR.codeLens.references': false, 'llvmIR.codeLens.controlFlowGraph': false });
  await cap.wait(1500);

  // diagnostics.png: every squiggle and faded unused value, plus one message.
  await cap.command('revealLine', { lineNumber: 4, at: 'top' });
  await cap.wait(300);
  const lineTop = async text => {
    const lines = await cap.evaluate(`[...document.querySelectorAll('.monaco-editor .view-lines .view-line')].map(e => ({ text: e.textContent.replace(/\\u00a0/g, ' '), y: e.getBoundingClientRect().top, h: e.getBoundingClientRect().height }))`);
    return lines.find(line => line.text.includes(text));
  };
  // Below the line, so the hover stays inside the crop.
  await cap.config({ 'editor.hover.above': false });
  await cap.cursor('%summ', { delta: 2 });
  await cap.hover();
  const [hoverBox] = await cap.elements('.monaco-hover');
  const [gutter] = await cap.elements('.editor-group-container.active .monaco-editor .margin');
  const first = await lineTop('define i32 @average'), last = await lineTop('ret i32 %a');
  await cap.shot('diagnostics', { region: { x: gutter.x, y: first.y, width: Math.min(1100, hoverBox.x + hoverBox.width + 16) - gutter.x, height: last.y + last.h - first.y } });
  await cap.key('Escape');
  // The light bulb would sit over the line above the cursor; the menu is enough.
  await cap.config({ 'editor.hover.above': true, 'editor.lightbulb.enabled': 'off' });
  await cap.command('workbench.action.focusActiveEditorGroup');
  await cap.key('Escape');
  await cap.wait(300);

  // quickfix-typo.gif: Ctrl+. on %summ, "Change to %sum", the squiggle goes away.
  await cap.cursor('%summ', { delta: 3 });
  let r = await cap.region(['cursor-text'], { lines: 3 });
  await cap.record('quickfix-typo', async () => {
    await cap.wait(1200);
    await cap.command('editor.action.quickFix');
    await cap.waitFor('.action-widget');
    const menu = await cap.elements('.action-widget');
    await cap.wait(1800);
    await cap.key('Enter');
    await cap.wait(2200);
  }, { region: { x: r.x, y: r.y, width: 680, height: r.height + 44 }, factor: 0.75 });

  // quickfix-variadic.gif: the printf warning; the fix spells the function type.
  await cap.cursor('@printf(ptr @message', { delta: 3 });
  r = await cap.region(['cursor-text'], { lines: 2 });
  await cap.record('quickfix-variadic', async () => {
    await cap.wait(1200);
    await cap.command('editor.action.quickFix');
    await cap.waitFor('.action-widget');
    const menu = await cap.elements('.action-widget');
    await cap.wait(1800);
    await cap.key('Enter');
    await cap.wait(2200);
  }, { region: { x: r.x, y: r.y, width: 820, height: r.height + 44 }, factor: 0.75 });
};
