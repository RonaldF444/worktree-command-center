import { app, BrowserWindow, ipcMain, dialog, clipboard, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createPhoneRoutes } from './remote-server';
import { remoteInfoPath, writeRemoteInfo, removeRemoteInfo } from './remote-info';
import { pickHosts, accessUrls, httpsUrlFor, hasServeHandlerFor, tailscaleIps, browserUrls } from './remote-net';
import { randomBytes } from 'crypto';
import { startGateway, type GatewayHandle } from './remote/gateway';
import { createAuth } from './remote/auth';
import { createRendererRpc } from './remote/renderer-rpc';
import { createRemoteHandlers } from './remote/handlers';
import { Worker } from 'worker_threads';

const REMOTE_PORT = 7420;
let win: BrowserWindow | null = null;
let gateway: GatewayHandle | null = null;
let floorState: unknown = { workspaces: [], centeredId: null, kane: null, terminals: [], repos: [] };
const phoneToken = randomBytes(8).toString('hex');

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

	// Browser mirror + phone floor view: one gateway, loopback + Tailscale only (spec 2026-09-07).
	const webDir = app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'dist', 'web') : path.join(__dirname, 'web');
	const auth = createAuth({ file: path.join(userData, 'remote-auth.json'), onDevicesRevoked: (ids) => gateway?.endDeviceSessions(ids) });
	const rpc = createRendererRpc({ send: (m) => { if (!win || win.isDestroyed()) throw new Error('no window'); win.webContents.send('remote:invoke', m); } });
	ipcMain.removeAllListeners('remote:state'); ipcMain.removeAllListeners('remote:reply'); ipcMain.removeAllListeners('remote:event');
	ipcMain.on('remote:state', (_e, s: unknown) => { floorState = s; });
	ipcMain.on('remote:reply', (_e, r: unknown) => rpc.handleReply(r));
	ipcMain.on('remote:event', (_e, m: { channel?: unknown; payload?: unknown }) => { if (typeof m?.channel === 'string') gateway?.broadcast(m.channel, m.payload); });
	win.webContents.on('did-start-loading', () => rpc.rejectAll());
	win.on('closed', () => rpc.rejectAll());
	const readConfig = (): unknown => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')); } catch { return {}; } };
	const tsIps = (): string[] => tailscaleIps(os.networkInterfaces());
	void startGateway({
		port: REMOTE_PORT,
		hosts: ['127.0.0.1', ...tsIps()],
		staticDir: webDir,
		table: createRemoteHandlers({ rpc, readConfig }),
		authenticate: (frame, ip) => auth.authenticate(frame, ip),
		phoneRoutes: createPhoneRoutes({ token: phoneToken, getFloor: () => floorState, onAction: (a) => win?.webContents.send('remote:action', a) }),
		// tailscale serve fronts us with the MagicDNS name as Host (Task 6 ruling).
		allowHost: (h) => h.endsWith('.ts.net'),
	}).then((gw) => {
		gateway = gw;
		gw.onClientCount((n) => win?.webContents.send('remote:clients', n));
		writeRemoteInfo(remoteInfoPath(), { url: `http://127.0.0.1:${gw.boundPort()}/phone`, token: phoneToken });
		// Tailscale often finishes starting after we do: re-check once a minute and bind late.
		const rebind = setInterval(() => { for (const ip of tsIps()) if (!gw.boundHosts().includes(ip)) void gw.addHost(ip); }, 60_000);
		rebind.unref();
	}).catch((err) => console.error('[remote] gateway failed to start:', err));

	ipcMain.handle('remote:info', async () => {
		const hosts = gateway?.boundHosts() ?? ['127.0.0.1'];
		return {
			token: phoneToken,
			port: REMOTE_PORT,
			urls: accessUrls(pickHosts(os.networkInterfaces(), os.hostname()).filter((h) => hosts.includes(h) || !/^\d/.test(h)), REMOTE_PORT, phoneToken),
			httpsUrl: httpsUrlFor(await tailscaleVoiceDnsName(REMOTE_PORT), phoneToken),
			browserUrls: browserUrls(hosts.filter((h) => h !== '127.0.0.1'), REMOTE_PORT),
			tailscaleUp: hosts.length > 1,
		};
	});
	ipcMain.handle('remote:password:set', (_e, pw: unknown) => auth.setPassword(String(pw ?? '')));
	ipcMain.handle('remote:password:has', () => auth.hasPassword());
	ipcMain.handle('remote:devices', () => auth.listDevices());
	ipcMain.handle('remote:devices:revoke', (_e, id: unknown) => auth.revokeDevice(String(id ?? '')));
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

/** Runs a short command on the dedicated worker thread above, same as `cmd:run`, so a slow
 *  or hung subprocess never blocks main's input pump. Returns stdout, or null on any failure
 *  (not found, non-zero exit, or timeout) — callers that just want "did this work" don't have
 *  to unpack the runner's full result shape. */
function runViaWorker(command: string, args: string[], timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const id = ++cmdSeq;
		cmdPending.set(id, (r: unknown) => {
			const res = r as { stdout: string; code: number | null; timedOut: boolean; error?: string };
			resolve(!res.error && !res.timedOut && res.code === 0 ? res.stdout : null);
		});
		ensureCmdRunner().postMessage({ id, command, args, opts: { timeoutMs } });
	});
}

/** This machine's MagicDNS name, but ONLY when `tailscale serve` has an active handler
 *  proxying to `port` — MagicDNS resolves the moment a device joins a tailnet, independent of
 *  whether `tailscale serve` was ever run, so the DNS name alone is not proof anything is
 *  listening on 443 (see hasServeHandlerFor). Best-effort and fully async, via the worker
 *  thread above: no Tailscale installed, not logged in, a daemon still starting, or serve
 *  never configured all yield null and the panel falls back to the setup hint. Read on each
 *  panel open rather than once at startup, because Tailscale often finishes starting after
 *  WCC does. */
async function tailscaleVoiceDnsName(port: number): Promise<string | null> {
	// runViaWorker can reject (not just resolve null) if ensureCmdRunner()'s `new Worker(...)`
	// throws synchronously inside the executor — e.g. worker_threads unavailable/misconfigured.
	// That would otherwise reject this Promise.all, then the whole `remote:info` handler below,
	// wiping out the plain http:// URLs too. Degrade to null instead: this helper is best-effort.
	const [statusOut, serveOut] = await Promise.all([
		runViaWorker('tailscale', ['status', '--json'], 2000).catch(() => null),
		runViaWorker('tailscale', ['serve', 'status', '--json'], 2000).catch(() => null),
	]);
	if (!statusOut || !serveOut) return null;
	try {
		const name = (JSON.parse(statusOut) as { Self?: { DNSName?: string } }).Self?.DNSName;
		if (typeof name !== 'string' || !name.trim()) return null;
		return hasServeHandlerFor(JSON.parse(serveOut), port) ? name : null;
	} catch { return null; }
}

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

// Drop the phone-floor access file so a stale token doesn't linger pointing at a dead port
// once this process exits.
app.on('before-quit', () => { removeRemoteInfo(remoteInfoPath()); void gateway?.close(); });
