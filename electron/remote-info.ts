import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface RemoteInfo { url: string; token: string; }

/** Where deskd (and anything else local) reads WCC's live phone-floor URL + token from. The
 *  token is regenerated every launch and was never written anywhere — making a proxy that
 *  fronts it un-configurable without hand-copying it after every restart. Fixed path, fixed
 *  shape; a consumer is being built against it. */
export function remoteInfoPath(): string {
	const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
	return path.join(localAppData, 'worktree-command-center', 'remote.json');
}

/** Best-effort: this file is a convenience for local proxies, not something WCC's own startup
 *  should ever fail over. Never logs `info` itself — it carries the access token. */
export function writeRemoteInfo(filePath: string, info: RemoteInfo): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf8');
	} catch (e) {
		console.error('[remote] failed to write remote.json:', e);
	}
}

/** Drops the stale token on quit so it doesn't linger pointing at a dead port. Best-effort —
 *  a missing file (never written, or already gone) is not an error. */
export function removeRemoteInfo(filePath: string): void {
	try { fs.unlinkSync(filePath); } catch { /* already gone, or never written */ }
}
