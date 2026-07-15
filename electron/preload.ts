import { ipcRenderer } from 'electron';

// contextIsolation is OFF (the renderer needs direct Node access), so `contextBridge`
// can't be used — it throws "contextBridge API can only be used when contextIsolation
// is enabled". With isolation off, the preload shares the renderer's window, so we
// assign the bridge object directly.
(window as unknown as { wcc: unknown }).wcc = {
	paths: () => ipcRenderer.invoke('paths'),
	getConfig: () => ipcRenderer.invoke('config:get'),
	setConfig: (c: unknown) => ipcRenderer.invoke('config:set', c),
	addFolder: () => ipcRenderer.invoke('addFolder'),
	// Clipboard via the MAIN process: renderer-side electron.clipboard is deprecated
	// (removal planned for Electron 40) and navigator.clipboard fails silently without
	// focus/permission — this path works identically in dev and packaged builds.
	clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
	clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text),
	// Phone floor view bridge.
	pushFloorState: (s: unknown) => ipcRenderer.send('remote:state', s),
	onRemoteAction: (cb: (a: unknown) => void) => ipcRenderer.on('remote:action', (_e, a) => cb(a)),
	remoteInfo: () => ipcRenderer.invoke('remote:info'),
};
