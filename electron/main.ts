import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let win: BrowserWindow | null = null;

function createWindow(): void {
	const sidecarDir = app.isPackaged
		? path.join(process.resourcesPath, 'pty-sidecar')
		: path.join(__dirname, '..', 'pty-sidecar');
	const userData = app.getPath('userData');

	win = new BrowserWindow({
		width: 1400,
		height: 900,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
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
}

app.whenReady().then(createWindow);

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
