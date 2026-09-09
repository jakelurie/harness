// Runs every *.test.mjs in this directory; exits non-zero if any fail.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  console.log(`\n\x1b[1m${file}\x1b[0m`);
  const res = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (res.status !== 0) failed += 1;
}

console.log(failed ? `\n\x1b[31m${failed} suite(s) failed\x1b[0m` : '\n\x1b[32mall suites green\x1b[0m');
process.exit(failed ? 1 : 0);
