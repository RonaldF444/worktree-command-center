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
	// Deterministic command execution in the MAIN process (see command-runner.ts).
	runCommand: (command: string, args: string[], opts?: object) => ipcRenderer.invoke('cmd:run', command, args, opts),
	// Phone floor view + browser mirror (electron/remote/*).
	pushFloorState: (s: unknown) => ipcRenderer.send('remote:state', s),
	onRemoteAction: (cb: (a: unknown) => void) => ipcRenderer.on('remote:action', (_e, a) => cb(a)),
	remoteInfo: () => ipcRenderer.invoke('remote:info'),
	onRemoteInvoke: (cb: (m: unknown) => void) => ipcRenderer.on('remote:invoke', (_e, m) => cb(m)),
	remoteReply: (r: unknown) => ipcRenderer.send('remote:reply', r),
	remoteEvent: (channel: string, payload: unknown) => ipcRenderer.send('remote:event', { channel, payload }),
	onRemoteClients: (cb: (n: number) => void) => ipcRenderer.on('remote:clients', (_e, n) => cb(n)),
	remotePasswordSet: (pw: string) => ipcRenderer.invoke('remote:password:set', pw),
	remoteHasPassword: () => ipcRenderer.invoke('remote:password:has'),
	remoteDevices: () => ipcRenderer.invoke('remote:devices'),
	remoteDeviceRevoke: (id: string) => ipcRenderer.invoke('remote:devices:revoke', id),
	// Shell digit shortcuts (Ctrl+digit, intercepted in main).
	onShellDigit: (cb: (n: number) => void) => ipcRenderer.on('shell:digit', (_e, n) => cb(n)),
};
