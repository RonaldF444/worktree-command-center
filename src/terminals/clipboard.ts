/** Renderer clipboard access, most-reliable path first:
 *  1. window.wcc IPC → electron.clipboard in the MAIN process. Renderer-side
 *     electron.clipboard is deprecated (removal planned for Electron 40) and
 *     navigator.clipboard fails silently without focus/permission — the IPC path works
 *     identically in dev and packaged builds.
 *  2. require('electron').clipboard — kept for embeddings without our preload.
 *  3. navigator.clipboard — async, permission-gated; last resort.
 */

interface WccClipboard { clipboardRead?: () => Promise<string>; clipboardWrite?: (t: string) => Promise<unknown> }

function wcc(): WccClipboard | undefined {
	return (window as unknown as { wcc?: WccClipboard }).wcc;
}

function electronClipboard(): { readText?: () => string; writeText?: (t: string) => void } | null {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (!req) return null;
		const mod = req('electron') as { clipboard?: { readText?: () => string; writeText?: (t: string) => void } };
		return mod.clipboard ?? null;
	} catch { return null; }
}

/** Read clipboard text — '' when empty or unavailable; never rejects. */
export async function readClipboardText(): Promise<string> {
	const ipc = wcc()?.clipboardRead;
	if (ipc) { try { return (await ipc()) ?? ''; } catch { /* main handler missing — fall through */ } }
	const sync = electronClipboard()?.readText?.();
	if (typeof sync === 'string') return sync;
	try { return (await navigator.clipboard?.readText?.()) ?? ''; } catch { return ''; }
}

/** Write clipboard text — best effort; never throws. */
export function writeClipboardText(text: string): void {
	const ipc = wcc()?.clipboardWrite;
	if (ipc) { void ipc(text).catch(() => { /* main handler missing — nothing better to try async */ }); return; }
	const clip = electronClipboard();
	if (clip?.writeText) { clip.writeText(text); return; }
	void navigator.clipboard?.writeText?.(text).catch(() => { /* denied */ });
}
