import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wcc', {
	paths: () => ipcRenderer.invoke('paths'),
	getConfig: () => ipcRenderer.invoke('config:get'),
	setConfig: (c: unknown) => ipcRenderer.invoke('config:set', c),
	addFolder: () => ipcRenderer.invoke('addFolder'),
});
