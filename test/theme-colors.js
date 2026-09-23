'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');
const manifest = require('../package.json');

// Use VS Code's actual bundled themes, not a hand-written imitation of their
// palette. Includes are applied before child rules, as in the theme service.
function readTheme(file) {
  const theme = JSON.parse(fs.readFileSync(file, 'utf8'));
  return [
    ...(theme.include ? readTheme(path.resolve(path.dirname(file), theme.include)) : []),
    ...(theme.tokenColors || [])
  ];
}

async function verifyThemeColors(themeDirectory) {
  await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
  const fallback = manifest.contributes.semanticTokenScopes[0].scopes.label[0];
  for (const [file, expected] of [
    ['dark_modern.json', {
      label: '#C8C8C8', instruction: '#C586C0', type: '#4EC9B0',
      variable: '#9CDCFE', function: '#DCDCAA', number: '#B5CEA8'
    }],
    ['light_modern.json', {
      label: '#000000', instruction: '#AF00DB', type: '#267F99',
      variable: '#001080', function: '#795E26', number: '#098658'
    }]
  ]) {
    const registry = new textmate.Registry({
      theme: { settings: readTheme(path.join(themeDirectory, file)) },
      onigLib: Promise.resolve({
        createOnigScanner: sources => new oniguruma.OnigScanner(sources),
        createOnigString: value => new oniguruma.OnigString(value)
      }),
      loadGrammar: async scope => scope === 'source.label-test'
        ? { scopeName: scope, patterns: [{ match: '.+', name: fallback }] }
        : textmate.parseRawGrammar(fs.readFileSync(path.join(__dirname, '../syntaxes/llvm-ir.tmLanguage.json'), 'utf8'), 'llvm.json')
    });
    try {
      const grammar = await registry.loadGrammar('source.llvm');
      const fallbackGrammar = await registry.loadGrammar('source.label-test');
      function color(line, target, selectedGrammar = grammar, delta = 0) {
        const at = line.indexOf(target) + delta;
        assert.ok(line.includes(target));
        const tokens = selectedGrammar.tokenizeLine2(line).tokens;
        for (let i = 0; i < tokens.length; i += 2) {
          if (tokens[i] <= at && (i + 2 === tokens.length || at < tokens[i + 2])) {
            // TextMate's encoded token metadata stores foreground in bits 15–23.
            return registry.getColorMap()[(tokens[i + 1] >>> 15) & 0x1FF].toUpperCase();
          }
        }
        assert.fail('No color for ' + target);
      }
      const actual = {
        label: color('entry:', 'entry'),
        instruction: color('%v = add i32 %x, 1', 'add'),
        type: color('%v = add i32 %x, 1', 'i32'),
        variable: color('%v = add i32 %x, 1', '%x', grammar, 1),
        function: color('call void @work()', '@work', grammar, 1),
        number: color('ret i32 42', '42')
      };
      assert.deepEqual(actual, expected, file + ' uses the expected standard palette');
      assert.equal(color('br label %entry', '%entry'), actual.label);
      assert.equal(color('%entry', '%entry', fallbackGrammar), actual.label, 'semantic fallback matches label grammar');
      assert.equal(new Set(Object.values(actual)).size, 6, 'all six roles have distinct colors');
      console.log('PASS: actual ' + file + ' palette — ' + JSON.stringify(actual));
    } finally {
      registry.dispose();
    }
  }
}

module.exports = { verifyThemeColors };
