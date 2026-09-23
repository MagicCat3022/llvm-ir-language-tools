'use strict';

// Runs every scenario in scripts/capture/scenarios/, one VS Code at a time.
//   node scripts/capture/all.js [name ...] [--out docs/media]
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const directory = path.join(__dirname, 'scenarios');
const args = process.argv.slice(2);
const names = args.filter(arg => !arg.startsWith('--') && !args[args.indexOf(arg) - 1]?.startsWith('--'));
const flags = args.filter(arg => !names.includes(arg));
const scenarios = fs.readdirSync(directory).filter(file => file.endsWith('.js') && (!names.length || names.includes(path.basename(file, '.js'))));
for (const file of scenarios) {
  console.log(`== ${file}`);
  execFileSync(process.execPath, [path.join(__dirname, 'cli.js'), path.join(directory, file), ...flags], { stdio: 'inherit' });
}
