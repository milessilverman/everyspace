// Runs every tests/*.e2e.mjs, one after the other, and exits non-zero if any fails. Files are found at run time, so a
// test added later is picked up with no change here. Optional arguments filter by file name: node tests/run-e2e.mjs home nav
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.e2e.mjs') && (!filters.length || filters.some((x) => f.includes(x)))).sort();
if (!files.length) { console.error('no tests/*.e2e.mjs files found'); process.exit(1); }

const results = [];
for (const f of files) {
  console.log(`\n=== ${f}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', cwd: path.join(dir, '..') });
  results.push({ f, ok: r.status === 0, s: ((Date.now() - t0) / 1000).toFixed(1), code: r.status ?? r.signal });
}
console.log('\n--- e2e summary');
for (const r of results) console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.f}  (${r.s}s${r.ok ? '' : `, exit ${r.code}`})`);
const bad = results.filter((r) => !r.ok);
if (bad.length) { console.error(`\n${bad.length} of ${results.length} e2e file(s) failed: ${bad.map((r) => r.f).join(', ')}`); process.exit(1); }
console.log(`\nall ${results.length} e2e file(s) passed`);
