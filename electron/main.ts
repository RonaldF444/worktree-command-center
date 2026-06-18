import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startRemoteServer } from './remote-server';
import { pickHosts, accessUrls } from './remote-net';

const REMOTE_PORT = 7420;
let win: BrowserWindow | null = null;

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
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	win.loadFile(path.join(__dirname, '..', 'index.html'));

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

app.whenReady().then(createWindow);

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
