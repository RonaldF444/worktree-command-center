/** Link handling for the embedded terminals: Ctrl/Cmd+click a URL to open it in the real
 *  browser, while plain clicks and drag-to-select stay untouched. */

export type LinkActivator = (event: MouseEvent, uri: string) => void;

/** Build a WebLinksAddon activation handler that only fires on Ctrl/Cmd+click. */
export function ctrlClickActivator(open: (uri: string) => void): LinkActivator {
	return (event, uri) => { if (event.ctrlKey || event.metaKey) open(uri); };
}

/** Open a URL in the user's real browser via Electron's shell; fall back to window.open. */
export function openExternalUrl(uri: string): void {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (req) {
			const shell = (req('electron') as { shell?: { openExternal?: (u: string) => void } }).shell;
			if (shell?.openExternal) { shell.openExternal(uri); return; }
		}
	} catch { /* not running under Electron */ }
	try { window.open(uri, '_blank'); } catch { /* no-op */ }
}
