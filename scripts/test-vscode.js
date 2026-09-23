'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'llvm-ir-vscode-test-'));
  try {
    const fixtures = path.join(temporary, 'fixtures');
    await fs.cp(path.resolve(__dirname, '../test/fixtures/workspace'), fixtures, { recursive: true });
    const workspaceFile = path.join(temporary, 'test.code-workspace');
    await fs.writeFile(workspaceFile, JSON.stringify({
      folders: [
        { name: 'LLVM project A', path: path.join(fixtures, 'project-a') },
        { name: 'LLVM project B', path: path.join(fixtures, 'project-b') }
      ]
    }));
    const options = {
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../test/integration/suite.js'),
      launchArgs: [
        workspaceFile,
        '--user-data-dir=' + path.join(temporary, 'user'),
        '--extensions-dir=' + path.join(temporary, 'extensions'),
        '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-gpu', '--no-sandbox', '--disable-workspace-trust'
      ]
    };
    if (process.env.VSCODE_EXECUTABLE_PATH) options.vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
    await runTests(options);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
