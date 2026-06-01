// Self-heal Electron's install on Windows + Node 24.
//
// electron's own postinstall downloads the runtime zip to the @electron/get cache,
// then extracts it with `extract-zip` — which silently fails under Node 24 (only the
// first archive entry lands in dist/, exit 0, no electron.exe). This script detects the
// missing binary and re-extracts the cached zip with native `Expand-Archive`, then writes
// the `path.txt` electron/index.js expects. No-ops when the binary is already present.
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';

const electronDir = join(process.cwd(), 'node_modules', 'electron');
if (!existsSync(electronDir)) process.exit(0); // electron not installed (e.g. CI without deps)

const exeName = platform() === 'win32' ? 'electron.exe' : 'electron';
const exePath = join(electronDir, 'dist', exeName);
if (existsSync(exePath)) { console.log('[fix-electron] electron binary already present — nothing to do'); process.exit(0); }

if (platform() !== 'win32') {
  console.log('[fix-electron] non-Windows: leave it to electron postinstall (run `node node_modules/electron/install.js` if missing)');
  process.exit(0);
}

const cacheRoot = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron', 'Cache');
function findZip() {
  if (!existsSync(cacheRoot)) return null;
  for (const d of readdirSync(cacheRoot)) {
    try { for (const f of readdirSync(join(cacheRoot, d))) if (f.endsWith('.zip')) return join(cacheRoot, d, f); } catch { /* skip */ }
  }
  return null;
}

let zip = findZip();
if (!zip) {
  console.log('[fix-electron] no cached zip — running electron downloader first…');
  try { execSync('node node_modules/electron/install.js', { stdio: 'inherit' }); } catch { /* extraction will fail; we only need the cached zip */ }
  zip = findZip();
}
if (!zip) { console.error('[fix-electron] could not find/download the electron zip; run `node node_modules/electron/install.js` manually'); process.exit(0); }

const dist = join(electronDir, 'dist');
console.log(`[fix-electron] extracting ${zip} → ${dist} via Expand-Archive…`);
execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zip}' -DestinationPath '${dist}' -Force"`, { stdio: 'inherit' });
writeFileSync(join(electronDir, 'path.txt'), exeName);
console.log(`[fix-electron] done — wrote dist/${exeName} + path.txt`);
