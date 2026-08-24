// Build the app (private overlay compiled in when present), package a Windows
// installer, and silently (re)install it per-user. Never launches the app — the
// user opens it from the Start Menu when they want it.
//
// Deliberately does NOT go through `npm run dist`: that script guards against
// accidentally publishing private code in a public installer. This one targets THIS
// machine only — artifacts land in the gitignored release-private/, kept separate
// from public release/ installers.
import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';

// Relative paths (private/, release-private/) assume the repo root — normalize cwd
// so `node scripts/install-local.mjs` works from anywhere, not just via npm.
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

if (platform() !== 'win32') {
	console.error('[install-local] Windows only — this packages and installs an NSIS app.');
	process.exit(1);
}

const OUT = 'release-private';
const EXE = 'Worktree Command Center.exe';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

// ─── FLOOR GUARD (Kane, 2026-08-23) ──────────────────────────────────────────
// A silent reinstall force-kills the running app (the taskkill below), and the
// app is the parent of EVERY live Claude terminal in every workspace - so one
// install nukes the whole floor mid-turn. It happened twice on 2026-08-23
// (board: app:install 14:03 and 18:56); each time every session died at once.
// Installing is only allowed when the app is not running, or when Ronald has
// explicitly approved the install IN THE CURRENT CONVERSATION. After his OK,
// re-run with the env var WCC_INSTALL_OK=1.
const appUp = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`], { encoding: 'utf8' })
	.stdout?.includes(EXE);
if (appUp && process.env.WCC_INSTALL_OK !== '1') {
	console.error(`[install-local] REFUSING: "${EXE}" is running. Installing now would kill every`);
	console.error('[install-local] live Claude session on the floor. Ask Ronald for an explicit OK in this');
	console.error('[install-local] conversation, then re-run with WCC_INSTALL_OK=1 set.');
	process.exit(2);
}

console.log(existsSync('private/index.ts')
	? '[install-local] private/ overlay present — compiling it in'
	: '[install-local] no private/ overlay — building the public app');

run('npm run build');
run(`npx electron-builder --win --config.directories.output=${OUT}`);

// Newest "<productName> Setup <version>.exe" in release-private/.
const setups = readdirSync(OUT)
	.filter((f) => /Setup .*\.exe$/i.test(f))
	.map((f) => ({ f, mtime: statSync(join(OUT, f)).mtimeMs }))
	.sort((a, b) => b.mtime - a.mtime);
if (!setups.length) {
	console.error(`[install-local] no "* Setup *.exe" found in ${OUT}/ — electron-builder output changed?`);
	process.exit(1);
}
const installer = join(OUT, setups[0].f);

// Close a running installed copy so the silent installer can replace its files.
// (Non-zero exit = not running; ignore. Dev sessions run as electron.exe, unaffected.)
spawnSync('taskkill', ['/IM', EXE, '/F'], { stdio: 'ignore' });

console.log(`[install-local] installing ${installer} silently…`);
const inst = spawnSync(installer, ['/S'], { stdio: 'inherit' });
if (inst.status !== 0) {
	const why = inst.status === null ? `failed to start: ${inst.error?.message ?? 'unknown error'}` : `exited with code ${inst.status}`;
	console.error(`[install-local] installer ${why}`);
	process.exit(1);
}

// Confirm the install landed — but do NOT launch the app; the user opens it from the
// Start Menu when they want it. NSIS one-click installs per-user under
// %LOCALAPPDATA%\Programs\<dir derived from productName>; glob instead of hardcoding.
const programs = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs');
let installed = null;
try {
	for (const d of readdirSync(programs)) {
		const p = join(programs, d, EXE);
		if (existsSync(p)) { installed = p; break; }
	}
} catch {
	// %LOCALAPPDATA%\Programs may not exist (e.g. NSIS honored a remembered
	// non-default install dir) — fall through to the not-found warning below.
}
if (!installed) {
	console.log(`[install-local] warning: ${EXE} not found under ${programs}\\* — the installer reported success, so check the Start Menu.`);
	process.exit(0);
}
console.log(`[install-local] done — installed at ${installed} (launch it from the Start Menu)`);
