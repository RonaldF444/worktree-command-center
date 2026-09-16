/** Copy text to the clipboard from the browser mirror.
 *
 *  Why this is not just `navigator.clipboard.writeText`: the gateway serves plain HTTP (a
 *  Tailscale IP — see electron/remote/gateway.ts), and browsers expose the async Clipboard API
 *  only in a SECURE context. On http:// `navigator.clipboard` is undefined, so the old
 *  `navigator.clipboard?.writeText(...)` optional-chained to undefined and copying silently did
 *  nothing. The legacy `document.execCommand('copy')` path still works over plain http, so it is
 *  the fallback — and the one that actually runs for Ron.
 *
 *  Deps are injectable so the decision logic is testable without a DOM. */
export interface CopyDeps {
	/** navigator.clipboard.writeText, when the page is a secure context. */
	writeAsync?: (text: string) => Promise<void>;
	/** execCommand('copy') via a temporary textarea — works over plain http. */
	writeLegacy?: (text: string) => boolean;
}

/** Try the modern API first, then the legacy one. Resolves true if either reported success. */
export async function copyText(text: string, deps: CopyDeps): Promise<boolean> {
	if (!text) return false;
	if (deps.writeAsync) {
		try { await deps.writeAsync(text); return true; } catch { /* denied/unavailable — fall back */ }
	}
	if (deps.writeLegacy) {
		try { return deps.writeLegacy(text); } catch { return false; }
	}
	return false;
}

/** The real browser wiring. `writeAsync` is omitted entirely when the Clipboard API is absent
 *  (http), so copyText goes straight to the legacy path instead of burning a rejected promise. */
export function browserCopyDeps(): CopyDeps {
	const deps: CopyDeps = {};
	const nav = typeof navigator !== 'undefined' ? navigator : undefined;
	if (nav?.clipboard?.writeText) deps.writeAsync = (t) => nav.clipboard.writeText(t);
	deps.writeLegacy = (text) => {
		// Restore focus afterwards: the textarea steals it from the terminal, and losing focus
		// mid-session means the next keystroke goes nowhere.
		const prev = document.activeElement as HTMLElement | null;
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
		document.body.appendChild(ta);
		try {
			ta.select();
			ta.setSelectionRange(0, text.length);
			return document.execCommand('copy');
		} finally {
			ta.remove();
			prev?.focus?.();
		}
	};
	return deps;
}
