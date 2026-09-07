import type { Bridge } from './bridge';

/** Allow-list: the server's error strings are fixed literals, but nothing else is ever echoed. */
export function describeAuthFailure(error: string | undefined): string {
	switch (error) {
		case 'invalid password': return 'Wrong password.';
		case 'too many attempts -- try again later': return 'Too many attempts. Wait 15 minutes and try again.';
		case 'no password set': return 'No password is set yet. Set one in the desktop app (📱 panel).';
		case 'device revoked': return 'This device was signed out from the desktop.';
		case 'not connected': return 'Not connected to the desktop. Retrying…';
		default: return 'Login failed.';
	}
}

export function guessDeviceLabel(ua: string): string {
	if (!ua) return 'Browser';
	const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
	const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
	return `${os} · ${br}`;
}

/** Password form. Resolves the page into the floor via onDone once the bridge reports 'open'. */
export function mountLogin(root: HTMLElement, bridge: Bridge, onDone: () => void): () => void {
	root.empty();
	const box = root.createDiv({ cls: 'web-login' });
	box.createDiv({ cls: 'web-login-h', text: '🌳 Worktree Command Center' });
	const sub = box.createDiv({ cls: 'web-login-sub', text: bridge.status() === 'login' ? 'Enter the password from the desktop app.' : 'Connecting to the desktop…' });
	const form = box.createEl('form', { cls: 'web-login-form' });
	const pw = form.createEl('input', { type: 'password', placeholder: 'Password', cls: 'web-login-pw', attr: { autocomplete: 'current-password', autofocus: 'true' } });
	const rememberRow = form.createDiv({ cls: 'web-login-row' });
	const remember = rememberRow.createEl('input', { type: 'checkbox', attr: { id: 'remember' } });
	remember.checked = true;
	rememberRow.createEl('label', { text: 'Remember this device for 30 days', attr: { for: 'remember' } });
	const btn = form.createEl('button', { text: 'Sign in', cls: 'web-login-btn', attr: { type: 'submit' } });
	const err = box.createDiv({ cls: 'web-login-err' });

	let busy = false;
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		if (busy) return;
		busy = true; btn.disabled = true; err.setText('');
		void bridge.submitPassword(pw.value, remember.checked, guessDeviceLabel(navigator.userAgent)).then((o) => {
			busy = false; btn.disabled = false;
			if (!o.ok) { err.setText(describeAuthFailure(o.error)); pw.select(); }
		});
	});
	const offStatus = bridge.onStatus((s) => {
		if (s === 'open') { onDone(); return; }
		sub.setText(s === 'login' ? 'Enter the password from the desktop app.' : s === 'offline' ? 'Desktop unreachable. Retrying…' : 'Connecting to the desktop…');
		btn.disabled = s !== 'login';
	});
	btn.disabled = bridge.status() !== 'login';
	pw.focus();
	return () => { offStatus(); box.remove(); };
}
