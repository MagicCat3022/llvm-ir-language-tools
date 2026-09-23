'use strict';

// Captures README screenshots and GIFs from a real VS Code window.
//
//   node scripts/capture/cli.js <scenario.js> [--out docs/media] [--port 9333]
//                               [--workspace docs/demo] [--width 1100] [--height 700] [--visible 1]
//
// A scenario is a module exporting `async (cap, vscode) => {}`, optionally with
// `module.exports.window = { width, height }`; see host.js for
// the `cap` API. VS Code starts with an isolated profile, the extension under
// development, and a remote-debugging port through which frames are captured.
// It renders off screen through Chromium's headless platform, so it needs no
// display; pass --visible 1 to watch the window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '../..');

function options(argv) {
  const result = { out: 'docs/media', port: 9333, workspace: 'docs/demo', width: 1100, height: 700, scale: 2 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(\w+)$/.exec(argv[i]);
    if (match) result[match[1]] = argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) throw new Error('usage: node scripts/capture/cli.js <scenario.js> [--out dir] [--port n] [--workspace dir]');
  result.scenario = path.resolve(rest[0]);
  // A scenario can ask for its window size (module.exports.window); flags win.
  const window = require(result.scenario).window || {};
  for (const key of ['width', 'height']) if (!argv.includes(`--${key}`) && window[key]) result[key] = window[key];
  return result;
}

// Settings for clean, legible captures: no minimap, welcome pages, chat or tips.
const userSettings = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'window.commandCenter': false,
  'window.titleBarStyle': 'custom',
  'editor.fontSize': 15,
  'editor.lineHeight': 22,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.hover.delay': 200,
  'editor.hover.sticky': true,
  'editor.renderWhitespace': 'none',
  'editor.guides.indentation': false,
  'editor.cursorBlinking': 'solid',
  'breadcrumbs.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
  'security.workspace.trust.enabled': false,
};

async function main() {
  const args = options(process.argv.slice(2));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'llvm-ir-capture-'));
  try {
    // Scenarios may edit files; work on a copy of the demo workspace.
    const workspace = path.join(temporary, 'workspace');
    fs.cpSync(path.resolve(root, args.workspace), workspace, { recursive: true });
    const user = path.join(temporary, 'user');
    fs.mkdirSync(path.join(user, 'User'), { recursive: true });
    fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify(userSettings, null, 2));
    const out = path.resolve(root, args.out);
    fs.mkdirSync(out, { recursive: true });
    const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'host.js'),
      extensionTestsEnv: {
        CAPTURE_SCENARIO: args.scenario, CAPTURE_OUT: out, CAPTURE_PORT: String(args.port),
        CAPTURE_WIDTH: String(args.width), CAPTURE_HEIGHT: String(args.height), CAPTURE_SCALE: String(args.scale),
      },
      launchArgs: [
        workspace,
        `--user-data-dir=${user}`,
        `--extensions-dir=${path.join(temporary, 'extensions')}`,
        `--remote-debugging-port=${args.port}`,
        '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        '--disable-gpu', '--no-sandbox',
        // Render off screen by default; --visible 1 shows the window instead.
        ...(args.visible ? [] : ['--ozone-platform=headless']),
      ],
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
