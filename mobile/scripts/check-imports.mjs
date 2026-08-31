// Static bundle-smoke check: verify every relative import in mobile sources
// resolves to a file that exists (same extensions Metro would resolve).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const indexExts = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) yield p;
  }
}

function resolves(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const e of exts) if (existsSync(base + e) && statSync(base + e).isFile()) return true;
  for (const e of indexExts) if (existsSync(base + e)) return true;
  return false;
}

const importRe = /(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
let failures = 0;
let checked = 0;
for (const file of [join(root, 'App.tsx'), ...walk(join(root, 'src'))]) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] || m[2];
    if (!spec.startsWith('.')) continue;
    checked++;
    if (!resolves(file, spec)) {
      failures++;
      console.error(`BROKEN: ${file.slice(root.length + 1)} -> ${spec}`);
    }
  }
}
console.log(`checked ${checked} relative imports, ${failures} broken`);
process.exit(failures ? 1 : 0);
