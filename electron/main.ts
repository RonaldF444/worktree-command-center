import { app, BrowserWindow, ipcMain, dialog, clipboard, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startRemoteServer } from './remote-server';
import { pickHosts, accessUrls } from './remote-net';
import { Worker } from 'worker_threads';

const REMOTE_PORT = 7420;
let win: BrowserWindow | null = null;

// Chromium's native window-occlusion detection misfires on this machine's display topology
// (virtual display adapters), throttling the renderer to ~1Hz while it looks "occluded" —
// measured as continuous 500-3000ms heartbeat gaps with an idle main thread (perf-log
// 2026-07-22). Occlusion-based throttling is worthless for a command center that must stay
// live anyway, so disable the calculation outright.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// TEMPORARY DIAGNOSTIC (2026-07-22, remove after the lag hunt): expose the DevTools
// protocol on localhost only, so a CPU profile of the renderer can be captured from
// outside while the lag is reproducing. Loopback-bound — not reachable off-machine.
app.commandLine.appendSwitch('remote-debugging-port', '9223');

function createWindow(): void {
	const sidecarDir = app.isPackaged
		? path.join(process.resourcesPath, 'pty-sidecar')
		: path.join(__dirname, '..', 'pty-sidecar');
	const userData = app.getPath('userData');

	// App / taskbar icon. .ico (multi-size) on Windows for crisp small sizes; .png elsewhere.
	// __dirname is dist/ in dev and inside app.asar when packaged — assets/ sits one level up in both.
	const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
	const iconPath = path.join(__dirname, '..', 'assets', iconFile);

	win = new BrowserWindow({
		width: 1400,
		height: 900,
		icon: iconPath,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			// Electron 33 sandboxes renderers by default; a sandboxed renderer has no
			// `require` even with nodeIntegration, so the bundle dies on its first require().
			// We load only local, trusted content, so disable the sandbox.
			sandbox: false,
			webviewTag: true, // shell overlays may embed web content as <webview>s (guarded below)
			// Never clamp this window's timers when Chromium thinks it's backgrounded/occluded —
			// terminals must keep flowing regardless (see the occlusion note at module scope).
			backgroundThrottling: false,
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	win.loadFile(path.join(__dirname, '..', 'index.html'));

	// F11 toggles native fullscreen. before-input-event fires ahead of the page AND
	// (via preventDefault) suppresses the default menu's own F11 accelerator, so the
	// toggle can't fire twice and works no matter which tile has focus.
	// Modifiers are excluded: Alt+F11 is the renderer's badge jump to the 11th visible tile.
	win.webContents.on('before-input-event', (event, input) => {
		if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control && !input.meta && !input.shift && !input.isAutoRepeat && win) {
			event.preventDefault();
			win.setFullScreen(!win.isFullScreen());
		}
		// Ctrl+1..9 are shell shortcuts, forwarded to the renderer (which may route them to
		// an overlay surface). Intercepted here (like F11) so they work with a tile focused.
		if (input.type === 'keyDown' && input.control && !input.alt && !input.meta && !input.shift && !input.isAutoRepeat && /^[1-9]$/.test(input.key) && win) {
			event.preventDefault();
			win.webContents.send('shell:digit', Number(input.key));
		}
	});

	// IPC: return resolved paths
	ipcMain.handle('paths', () => ({ sidecarDir, userData }));

	// IPC: read config.json from userData
	ipcMain.handle('config:get', () => {
		const configPath = path.join(userData, 'config.json');
		try {
			const raw = fs.readFileSync(configPath, 'utf8');
			return JSON.parse(raw);
		} catch {
			return {};
		}
	});

	// IPC: write config.json to userData
	ipcMain.handle('config:set', (_event: Electron.IpcMainInvokeEvent, cfg: unknown) => {
		const configPath = path.join(userData, 'config.json');
		fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
		return true;
	});

	// IPC: show open-directory dialog
	ipcMain.handle('addFolder', async () => {
		const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
		return r.canceled ? null : r.filePaths[0];
	});

	// Phone floor view: HTTP server (Tailscale-reachable) + the access info for the topbar panel.
	const { token } = startRemoteServer({ port: REMOTE_PORT, getWindow: () => win });
	ipcMain.handle('remote:info', () => ({
		token,
		port: REMOTE_PORT,
		urls: accessUrls(pickHosts(os.networkInterfaces(), os.hostname()), REMOTE_PORT, token),
	}));
}

// Clipboard lives in the MAIN process (renderer-side electron.clipboard is deprecated).
// Registered at module scope, not in createWindow(), so a re-created window can't
// double-register the handlers.
// Short deterministic commands (git etc.) run in a DEDICATED WORKER THREAD. spawn()'s
// CreateProcess call blocks whichever thread issues it (~50-100ms each with AV): on the
// renderer it stuttered painting; on main it delayed every input event (all OS input
// routes through main). The worker absorbs the block; nothing user-facing waits on it.
const RUNNER_SRC = `
const { parentPort } = require('worker_threads');
const { spawn } = require('child_process');
parentPort.on('message', ({ id, command, args, opts }) => {
	const timeoutMs = (opts && opts.timeoutMs) || 15000;
	const exe = process.platform === 'win32' ? command + '.exe' : command;
	let proc;
	try { proc = spawn(exe, args, { cwd: opts && opts.cwd, windowsHide: true }); }
	catch (err) { parentPort.postMessage({ id, r: { stdout: '', stderr: '', code: null, timedOut: false, error: String(err && err.message) } }); return; }
	let stdout = '', stderr = '', settled = false;
	const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); parentPort.postMessage({ id, r }); };
	const timer = setTimeout(() => {
		try {
			if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
			else process.kill(-proc.pid, 'SIGKILL');
		} catch { /* best effort */ }
		done({ stdout, stderr, code: null, timedOut: true, error: 'timed out after ' + Math.round(timeoutMs / 1000) + 's' });
	}, timeoutMs);
	if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); });
	if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });
	proc.on('error', (err) => done({ stdout, stderr, code: null, timedOut: false, error: err.message }));
	proc.on('exit', (code) => done({ stdout, stderr, code, timedOut: false }));
});
`;
let cmdRunner: Worker | null = null;
let cmdSeq = 0;
const cmdPending = new Map<number, (r: unknown) => void>();
function ensureCmdRunner(): Worker {
	if (cmdRunner) return cmdRunner;
	cmdRunner = new Worker(RUNNER_SRC, { eval: true });
	cmdRunner.on('message', (m: { id: number; r: unknown }) => {
		const cb = cmdPending.get(m.id);
		if (cb) { cmdPending.delete(m.id); cb(m.r); }
	});
	cmdRunner.on('exit', () => {
		cmdRunner = null; // respawned lazily on next use
		for (const cb of cmdPending.values()) cb({ stdout: '', stderr: '', code: null, timedOut: false, error: 'command runner exited' });
		cmdPending.clear();
	});
	return cmdRunner;
}
ipcMain.handle('cmd:run', (_e, command: unknown, args: unknown, opts: unknown) => new Promise((resolve) => {
	const id = ++cmdSeq;
	cmdPending.set(id, resolve);
	ensureCmdRunner().postMessage({ id, command: String(command), args: Array.isArray(args) ? args.map(String) : [], opts: opts ?? {} });
}));

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_e, text: unknown) => { clipboard.writeText(String(text ?? '')); return true; });

// App-tab webviews: window.open/target=_blank goes to the real browser, never a new
// Electron window. (Webviews get the allowpopups attr so this handler fires at all.)
app.on('web-contents-created', (_e, contents) => {
	if (contents.getType() !== 'webview') return;
	contents.setWindowOpenHandler(({ url }) => {
		// Only web/mail links may leave the app — an embedded page must not be able to
		// launch file:// or arbitrary protocol handlers on the host.
		try {
			const { protocol } = new URL(url);
			if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
				shell.openExternal(url).catch(() => { /* no handler / user declined */ });
			}
		} catch { /* unparseable url — drop it */ }
		return { action: 'deny' };
	});
	// A focused webview swallows keyboard input before the host's before-input-event
	// can see it — mirror the host's F11 + Ctrl+digit handling on the guest.
	contents.on('before-input-event', (event, input) => {
		if (input.type !== 'keyDown' || input.isAutoRepeat || !win) return;
		if (input.key === 'F11' && !input.alt && !input.control && !input.meta && !input.shift) {
			event.preventDefault();
			win.setFullScreen(!win.isFullScreen());
			return;
		}
		if (input.control && !input.alt && !input.meta && !input.shift && /^[1-9]$/.test(input.key)) {
			event.preventDefault();
			win.webContents.send('shell:digit', Number(input.key));
		}
	});
});

app.whenReady().then(createWindow);

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
