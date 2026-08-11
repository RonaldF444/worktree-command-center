/** Link handling for the embedded terminals: Ctrl/Cmd+click a URL to open it in the real
 *  browser, while plain clicks and drag-to-select stay untouched. */

export type LinkActivator = (event: MouseEvent, uri: string) => void;

/** Build a WebLinksAddon activation handler that only fires on Ctrl/Cmd+click. Pass
 *  `suppressed` to yield when someone else owns the click — e.g. the claude TUI with
 *  mouse tracking on (v2.1.227+) opens clicked links ITSELF, so firing here too opened
 *  every link twice. */
export function ctrlClickActivator(open: (uri: string) => void, suppressed?: () => boolean): LinkActivator {
	return (event, uri) => { if ((event.ctrlKey || event.metaKey) && !suppressed?.()) open(uri); };
}

/** Same-URL debounce: xterm can hold two link sources over the same cells (an OSC 8
 *  hyperlink whose visible text is also a URL matches the WebLinksAddon regex too), and
 *  one click then activates both. Collapse identical opens inside this window. */
export const OPEN_DEDUPE_MS = 600;
let lastUri = '';
let lastAt = 0;
export function shouldOpen(uri: string, now: number): boolean {
	if (uri === lastUri && now - lastAt < OPEN_DEDUPE_MS) return false;
	lastUri = uri; lastAt = now;
	return true;
}

/** Open a URL in the user's real browser via Electron's shell; fall back to window.open. */
export function openExternalUrl(uri: string): void {
	if (!shouldOpen(uri, Date.now())) return;
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (req) {
			const shell = (req('electron') as { shell?: { openExternal?: (u: string) => void } }).shell;
			if (shell?.openExternal) { shell.openExternal(uri); return; }
		}
	} catch { /* not running under Electron */ }
	try { window.open(uri, '_blank'); } catch { /* no-op */ }
}
