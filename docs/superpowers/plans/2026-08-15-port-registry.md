# Localhost Port Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give WCC one always-visible list of every localhost dev-server URL its terminals have printed, grouped by worktree, with click-to-open and an in-app peek pane.

**Architecture:** A pure scanner reads loopback URLs out of raw pty output at `TerminalTile.writeOut()` — the single choke point every byte of session output passes through. Hits go to a per-grid registry keyed on `host:port`, live-only and never persisted. A topbar widget (a structural sibling of the existing `AttentionWidget`) renders the registry, and a single reusable `<webview>` overlay peeks pages without opening a browser tab.

**Tech Stack:** TypeScript (strict), Electron 33, xterm.js, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-port-registry-design.md`

## Global Constraints

- **Branch first.** The repo default branch is `main`; work on `feat/port-registry`. Do not commit to `main`.
- **Never build, package, or install.** `npm run build`, `npm run dist`, and `npm run install-local` are forbidden — the user builds and installs themselves. Typecheck with `npx tsc -noEmit -skipLibCheck`, which emits nothing.
- **Never launch the app.** No `npm start`, no `electron .`. Verification is tests plus typecheck.
- **No new dependencies.** Nothing added to `package.json`.
- **Indentation is tabs** in `src/`, matching every neighbouring file.
- **Comments explain why, not what** — match the density and voice of `src/terminals/links.ts` and `src/terminals/attention.ts`.
- **Registry is live-only.** Nothing about ports is written to disk or to the session file.

---

### Task 1: URL scanner

The scanner is pure and heavily unit-tested because everything else depends on it being right about messy pty output. It lives beside the other pure modules (`links.ts`, `usage-parse.ts`, `prompt-detect.ts`).

**Files:**
- Create: `src/terminals/port-scan.ts`
- Test: `tests/port-scan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PortHit { url: string; host: string; port: number; path: string; }`
  - `interface ScanMatch extends PortHit { index: number; length: number; }`
  - `function stripAnsi(s: string): string`
  - `function scanText(text: string): ScanMatch[]`
  - `class PortScanner { feed(chunk: string): PortHit[] }`
  - `const CARRY_CHARS = 256`

- [ ] **Step 1: Write the failing test**

Create `tests/port-scan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PortScanner, scanText, stripAnsi } from '../src/terminals/port-scan';

const urls = (hits: { url: string }[]): string[] => hits.map((h) => h.url);

describe('stripAnsi', () => {
	it('drops SGR colour but keeps the text around it', () => {
		expect(stripAnsi('\x1b[32m➜\x1b[0m  Local: http://localhost:5173/')).toBe('➜  Local: http://localhost:5173/');
	});
	it('keeps an OSC 8 hyperlink TARGET as plain text (the visible label may not be the URL)', () => {
		expect(stripAnsi('\x1b]8;;http://localhost:3000\x07open me\x1b]8;;\x07')).toContain('http://localhost:3000');
	});
});

describe('scanText', () => {
	it('finds a coloured vite Local line', () => {
		expect(urls(scanText(stripAnsi('  \x1b[32m➜\x1b[0m  Local:   http://localhost:5173/\n')))).toEqual(['http://localhost:5173/']);
	});
	it('normalises loopback aliases to localhost', () => {
		expect(urls(scanText('http://127.0.0.1:3000/ http://0.0.0.0:8080/'))).toEqual(['http://localhost:3000/', 'http://localhost:8080/']);
	});
	it('accepts a bare host:port and defaults the scheme', () => {
		expect(urls(scanText('server ready at localhost:3000'))).toEqual(['http://localhost:3000']);
	});
	it('keeps private LAN addresses — that is the URL that works from a phone', () => {
		expect(urls(scanText('Network: http://192.168.1.42:5173/'))).toEqual(['http://192.168.1.42:5173/']);
	});
	it('ignores public hosts — this is a dev-server list, not browser history', () => {
		expect(scanText('https://github.com:443/x https://example.com:8080/')).toEqual([]);
	});
	it('does not match a localhost-suffixed hostname', () => {
		expect(scanText('http://notlocalhost:3000/')).toEqual([]);
	});
	it('trims trailing sentence punctuation off the path', () => {
		expect(urls(scanText('see http://localhost:3000/api. done'))).toEqual(['http://localhost:3000/api']);
	});
});

describe('PortScanner', () => {
	it('reassembles a URL split across two pty writes', () => {
		const s = new PortScanner();
		expect(s.feed('  Local: http://localho')).toEqual([]);
		expect(urls(s.feed('st:3000/\n'))).toEqual(['http://localhost:3000/']);
	});
	it('never reports the same occurrence twice as the carry window slides', () => {
		const s = new PortScanner();
		expect(urls(s.feed('http://localhost:5173/\n'))).toEqual(['http://localhost:5173/']);
		expect(s.feed('building…\n')).toEqual([]);
		expect(s.feed('done\n')).toEqual([]);
	});
	it('holds a hit that ends exactly at the chunk boundary until it is proven complete', () => {
		const s = new PortScanner();
		expect(s.feed('http://localhost:300')).toEqual([]); // could be :3000 — do not report :300
		expect(urls(s.feed('0/\n'))).toEqual(['http://localhost:3000/']);
	});
	it('reports two distinct servers printed on one line', () => {
		const s = new PortScanner();
		expect(urls(s.feed('web http://localhost:3000/ api http://localhost:3001/api\n')))
			.toEqual(['http://localhost:3000/', 'http://localhost:3001/api']);
	});
	it('exposes host, port and path as parsed fields', () => {
		const s = new PortScanner();
		expect(s.feed('http://127.0.0.1:8080/health\n')).toEqual([
			{ url: 'http://localhost:8080/health', host: 'localhost', port: 8080, path: '/health' },
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/port-scan.test.ts`
Expected: FAIL — `Failed to resolve import "../src/terminals/port-scan"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/terminals/port-scan.ts`:

```ts
/** Pull the dev-server URLs a session prints out of raw pty output. Pure scan + a small
 *  stateful wrapper, because a pty write can split a URL in half. */

export interface PortHit { url: string; host: string; port: number; path: string; }
export interface ScanMatch extends PortHit { index: number; length: number; }

/** Loopback + private LAN only. A public URL in agent output is a citation, not a server. */
const HOST = String.raw`localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}`;
/** The lookbehind stops `notlocalhost:3000` matching on its tail. A port is required — an
 *  unported `http://localhost/` is too ambiguous to be worth a row. */
const URL_RE = new RegExp(String.raw`(?<![\w.-])(?:(https?):\/\/)?(${HOST}):(\d{2,5})(\/[^\s"'\`<>)\]]*)?`, 'gi');

/** OSC 8 hyperlink: ESC ] 8 ; params ; URI (BEL | ESC \). Claude emits these, and the visible
 *  label is often not the URL — so keep the TARGET as plain text for the scan below. */
const OSC8_RE = /\x1b]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC_RE = /\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;

const LOOPBACK = new Set(['127.0.0.1', '0.0.0.0', '[::1]']);

/** Strip terminal escapes, but unwrap OSC 8 targets into the text rather than deleting them.
 *  One cleaned stream keeps the offset bookkeeping in PortScanner honest. */
export function stripAnsi(s: string): string {
	return s.replace(OSC8_RE, ' $1 ').replace(OSC_RE, '').replace(CSI_RE, '');
}

function normalizeHost(h: string): string {
	const l = h.toLowerCase();
	// 0.0.0.0 means "all interfaces" — a browser cannot navigate to it, so open it as localhost.
	return LOOPBACK.has(l) ? 'localhost' : l;
}

/** `see http://localhost:3000.` must not yield a URL ending in a period. */
function trimTrailing(p: string): string { return p.replace(/[.,;:!?'")\]}]+$/, ''); }

export function scanText(text: string): ScanMatch[] {
	const out: ScanMatch[] = [];
	URL_RE.lastIndex = 0;
	for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
		const port = Number(m[3]);
		if (!port || port > 65535) continue;
		const rawPath = m[4] ?? '';
		const path = trimTrailing(rawPath);
		const scheme = (m[1] ?? 'http').toLowerCase();
		const host = normalizeHost(m[2]);
		out.push({
			url: `${scheme}://${host}:${port}${path}`,
			host, port, path,
			index: m.index,
			length: m[0].length - (rawPath.length - path.length),
		});
	}
	return out;
}

export const CARRY_CHARS = 256;

/** Feeds cleaned output through `scanText`, carrying a tail across calls so a URL split by a
 *  pty write is still found, and tracking absolute offsets so the overlap is not re-reported. */
export class PortScanner {
	private carry = '';
	private absBase = 0;     // absolute offset of carry[0] in the cleaned stream
	private emittedUpTo = 0; // absolute end of the last hit reported

	feed(chunk: string): PortHit[] {
		const text = this.carry + stripAnsi(chunk);
		const textEnd = this.absBase + text.length;
		const hits: PortHit[] = [];
		for (const m of scanText(text)) {
			const absStart = this.absBase + m.index;
			const absEnd = absStart + m.length;
			// Touching the boundary means it may be truncated (`:300` that is really `:3000`).
			// Leave it for the next feed, where the carry will present it whole.
			if (absEnd >= textEnd) continue;
			if (absStart < this.emittedUpTo) continue; // already reported on an earlier feed
			this.emittedUpTo = absEnd;
			hits.push({ url: m.url, host: m.host, port: m.port, path: m.path });
		}
		const keep = text.slice(-CARRY_CHARS);
		this.absBase += text.length - keep.length;
		this.carry = keep;
		return hits;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/port-scan.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/port-registry
git add src/terminals/port-scan.ts tests/port-scan.test.ts
git commit -m "feat(ports): scan pty output for localhost dev-server URLs"
```

---

### Task 2: Port registry

**Files:**
- Create: `src/terminals/port-registry.ts`
- Test: `tests/port-registry.test.ts`

**Interfaces:**
- Consumes: `PortHit` from `./port-scan` (Task 1).
- Produces:
  - `interface PortEntry { key: string; url: string; host: string; port: number; path: string; tileId: number; firstSeenMs: number; lastSeenMs: number; }`
  - `interface PortItem extends PortEntry { name: string; repo: string; }`
  - `const MAX_ENTRIES = 200`
  - `class PortRegistry { note(tileId: number, hit: PortHit, nowMs: number): void; forget(tileId: number): void; list(): PortEntry[]; }`

- [ ] **Step 1: Write the failing test**

Create `tests/port-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PortRegistry, MAX_ENTRIES } from '../src/terminals/port-registry';
import type { PortHit } from '../src/terminals/port-scan';

const hit = (port: number, path = '', host = 'localhost'): PortHit => ({ url: `http://${host}:${port}${path}`, host, port, path });

describe('PortRegistry', () => {
	it('collapses repeats of one server into a single entry and keeps the newest URL', () => {
		const r = new PortRegistry();
		r.note(1, hit(3000, '/'), 100);
		r.note(1, hit(3000, '/dashboard'), 200);
		expect(r.list()).toEqual([
			{ key: 'localhost:3000', url: 'http://localhost:3000/dashboard', host: 'localhost', port: 3000, path: '/dashboard', tileId: 1, firstSeenMs: 100, lastSeenMs: 200 },
		]);
	});

	it('moves a recycled port to its new owner instead of duplicating the row', () => {
		const r = new PortRegistry();
		r.note(1, hit(3000), 100);
		r.note(2, hit(3000), 500);
		const rows = r.list();
		expect(rows).toHaveLength(1);
		expect(rows[0].tileId).toBe(2);
		expect(rows[0].firstSeenMs).toBe(100); // the port has been alive since 100, under new ownership
	});

	it('forgets exactly one terminal\'s rows when it closes', () => {
		const r = new PortRegistry();
		r.note(1, hit(3000), 100);
		r.note(2, hit(3001), 100);
		r.forget(1);
		expect(r.list().map((e) => e.port)).toEqual([3001]);
	});

	it('keeps different hosts on the same port apart', () => {
		const r = new PortRegistry();
		r.note(1, hit(5173), 100);
		r.note(1, hit(5173, '/', '192.168.1.42'), 100);
		expect(r.list().map((e) => e.key)).toEqual(['localhost:5173', '192.168.1.42:5173']);
	});

	it('evicts the least recently seen entry at the cap', () => {
		const r = new PortRegistry();
		for (let i = 0; i < MAX_ENTRIES; i++) r.note(1, hit(3000 + i), 1000 + i);
		r.note(1, hit(9999), 9_000);
		const rows = r.list();
		expect(rows).toHaveLength(MAX_ENTRIES);
		expect(rows.some((e) => e.port === 3000)).toBe(false); // oldest lastSeenMs went
		expect(rows.some((e) => e.port === 9999)).toBe(true);
	});

	it('sorts by owning tile then port so the rendered list does not jitter', () => {
		const r = new PortRegistry();
		r.note(2, hit(3001), 100);
		r.note(1, hit(5173), 100);
		r.note(1, hit(3000), 100);
		expect(r.list().map((e) => [e.tileId, e.port])).toEqual([[1, 3000], [1, 5173], [2, 3001]]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/port-registry.test.ts`
Expected: FAIL — `Failed to resolve import "../src/terminals/port-registry"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/terminals/port-registry.ts`:

```ts
import type { PortHit } from './port-scan';

/** One live dev server, owned by the terminal that most recently printed it. */
export interface PortEntry {
	key: string;   // normalised `host:port`
	url: string;
	host: string;
	port: number;
	path: string;  // last seen path, rendered as the row's subtitle
	tileId: number;
	firstSeenMs: number;
	lastSeenMs: number;
}

/** A PortEntry with the display fields the grid resolves (see TerminalsGrid.portItems). */
export interface PortItem extends PortEntry { name: string; repo: string; }

export const MAX_ENTRIES = 200;

/** Every localhost URL the sessions in ONE grid have printed. Live-only and never persisted:
 *  a remembered URL outlives its server, and a stale row is worse than a missing one because
 *  it looks trustworthy. Rows die with the terminal that printed them (see forget). */
export class PortRegistry {
	private entries = new Map<string, PortEntry>();

	note(tileId: number, hit: PortHit, nowMs: number): void {
		const key = `${hit.host}:${hit.port}`;
		const prev = this.entries.get(key);
		// Newest printer owns the row: when a killed server frees :3000 and another worktree
		// grabs it, the row moves rather than the list growing a duplicate.
		this.entries.set(key, {
			key, url: hit.url, host: hit.host, port: hit.port, path: hit.path, tileId,
			firstSeenMs: prev?.firstSeenMs ?? nowMs,
			lastSeenMs: nowMs,
		});
		this.evict();
	}

	forget(tileId: number): void {
		for (const [key, e] of this.entries) if (e.tileId === tileId) this.entries.delete(key);
	}

	list(): PortEntry[] {
		return [...this.entries.values()].sort((a, b) => a.tileId - b.tileId || a.port - b.port);
	}

	private evict(): void {
		while (this.entries.size > MAX_ENTRIES) {
			let oldestKey = '';
			let oldestAt = Infinity;
			for (const [key, e] of this.entries) if (e.lastSeenMs < oldestAt) { oldestAt = e.lastSeenMs; oldestKey = key; }
			this.entries.delete(oldestKey);
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/port-registry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/terminals/port-registry.ts tests/port-registry.test.ts
git commit -m "feat(ports): live registry of dev servers keyed by host:port"
```

---

### Task 3: Capture wiring — tile hook and grid snapshot

This task has no new unit tests. `TerminalTile` and `TerminalsGrid` need an Electron renderer, a real xterm and a pty sidecar to construct, which is why the repo tests `attention.ts` but not `attention-widget.ts` or the grid. Verification is the full suite plus a typecheck; the logic being wired was already tested in Tasks 1 and 2.

**Files:**
- Modify: `src/terminals/terminal-tile.ts` — opts interface (~line 20-44), a new field (~line 73), `writeOut` (line 360)
- Modify: `src/terminals/terminals-grid.ts` — a new field (~line 139), `makeTile` opts (line 1194), `onClosed` (line 1210), a new method beside `attentionItems` (line 605)

**Interfaces:**
- Consumes: `PortScanner`, `PortHit` (Task 1); `PortRegistry`, `PortItem` (Task 2).
- Produces: `TerminalsGrid.portItems(): PortItem[]` — consumed by Task 4.

- [ ] **Step 1: Add the scanner to TerminalTile**

In `src/terminals/terminal-tile.ts`, add to the imports near the other `./` imports:

```ts
import { PortScanner, type PortHit } from './port-scan';
```

Add to `TerminalTileOpts`, directly after the `onReady?: (tile: TerminalTile) => void;` line:

```ts
	onPortSeen?: (tile: TerminalTile, hit: PortHit) => void;
```

Add a field beside the other private fields, next to `private hiddenBuf = new HiddenOutputBuffer();`:

```ts
	private portScanner = new PortScanner();
```

- [ ] **Step 2: Hook the one output choke point**

Replace `writeOut` at `src/terminals/terminal-tile.ts:360`:

```ts
	/** Route session output to xterm — or, in a batching mode, into the pending buffer. */
	private writeOut(d: string): void {
		// Scan BEFORE the mode branch: hidden and suspended tiles still print dev-server URLs,
		// and their ports belong in the list exactly like a foreground tile's.
		if (this.opts.onPortSeen) for (const hit of this.portScanner.feed(d)) this.opts.onPortSeen(this, hit);
		if (this.currentMode !== 'live') this.hiddenBuf.push(d);
		else this.term?.write(d);
	}
```

- [ ] **Step 3: Own the registry in the grid**

In `src/terminals/terminals-grid.ts`, add to the imports:

```ts
import { PortRegistry, type PortItem } from './port-registry';
```

Add a field beside `private idleTiles = new Set<number>();` (line 139):

```ts
	private ports = new PortRegistry();
```

In `makeTile` (line 1194), add to the options object immediately after the `onReady: (t) => this.handleReady(t),` line:

```ts
			onPortSeen: (t, hit) => this.ports.note(t.tileId, hit, Date.now()),
```

In the same object's `onClosed` handler (line 1210), add `this.ports.forget(t.tileId);` as the first statement, beside the existing `this.idleTiles.delete(t.tileId);`. Restart-in-place deliberately does not forget — killing the Claude process rarely kills the dev server it spawned behind it.

- [ ] **Step 4: Expose the snapshot**

Add this method directly after `attentionItems()` (which ends at `src/terminals/terminals-grid.ts:610`):

```ts
	/** Snapshot of every live dev server, with the terminal + repo that owns it, for the
	 *  topbar ports list. Entries whose tile has gone are dropped defensively — forget() on
	 *  close should already have removed them. */
	portItems(): PortItem[] {
		const byId = new Map(this.allSessions().map((t) => [t.tileId, t]));
		const out: PortItem[] = [];
		for (const e of this.ports.list()) {
			const t = byId.get(e.tileId);
			if (!t) continue;
			out.push({ ...e, name: t.name, repo: this.repoNameFor(t) });
		}
		// Sort by REPO first: the widget emits a heading whenever the repo changes, so two
		// terminals of one repo must be contiguous even when another repo's tile sits between
		// them by id. Registry order (tile, port) cannot do this — repo is a grid-level concept.
		return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.tileId - b.tileId || a.port - b.port);
	}
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npx vitest run`
Expected: PASS — the whole suite, with the 21 new tests from Tasks 1 and 2 included.

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no output (clean typecheck, no files emitted).

- [ ] **Step 6: Commit**

```bash
git add src/terminals/terminal-tile.ts src/terminals/terminals-grid.ts
git commit -m "feat(ports): capture URLs from session output into the grid registry"
```

---

### Task 4: Topbar ports widget

**Files:**
- Create: `src/ui/ports-widget.ts`
- Modify: `app.css` — new rules after the `.wcc-attn-*` block (lines 161-175)
- Modify: `src/app.ts` — import block (lines 1-20), wiring after `gridContainer` (~line 186)

**Interfaces:**
- Consumes: `TerminalsGrid.portItems()` (Task 3); `openExternalUrl` from `src/terminals/links.ts`; `writeClipboardText` from `src/terminals/clipboard.ts`.
- Produces: `class PortsWidget { constructor(provider: () => PortItem[], onReveal: (tileId: number) => void, onPeek: (url: string) => void); render(parent: HTMLElement): void; dispose(): void }` — `onPeek` is fulfilled by Task 5.

- [ ] **Step 1: Write the widget**

Create `src/ui/ports-widget.ts`:

```ts
import type { PortItem } from '../terminals/port-registry';
import { openExternalUrl } from '../terminals/links';
import { writeClipboardText } from '../terminals/clipboard';

/** Topbar ports badge + dropdown: every localhost URL the sessions have printed, grouped by
 *  repo. Structural sibling of AttentionWidget — same poll/dismiss/dispose shape. */
export class PortsWidget {
	private btn: HTMLButtonElement | null = null;
	private menu: HTMLElement | null = null;
	private open = false;
	private timer: number | null = null;
	private onDocClick: ((e: MouseEvent) => void) | null = null;

	constructor(
		private provider: () => PortItem[],
		private onReveal: (tileId: number) => void,
		private onPeek: (url: string) => void,
	) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-ports' });
		this.btn = el.createEl('button', { cls: 'wcc-ports-btn', text: '⇢', attr: { title: 'Dev servers these terminals have printed' } });
		this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
		this.menu = el.createDiv({ cls: 'wcc-ports-menu' });
		this.menu.style.display = 'none';
		this.onDocClick = () => { if (this.open) this.toggle(false); };
		document.addEventListener('click', this.onDocClick);
		this.tick();
		this.timer = window.setInterval(() => this.tick(), 1500);
	}

	private tick(): void {
		const items = this.provider();
		if (this.btn) this.btn.setText(items.length > 0 ? `⇢ ${items.length}` : '⇢');
		if (this.open) this.renderMenu(items);
	}

	private toggle(force?: boolean): void {
		this.open = force ?? !this.open;
		if (this.menu) this.menu.style.display = this.open ? 'block' : 'none';
		if (this.open) this.renderMenu(this.provider());
	}

	private renderMenu(items: PortItem[]): void {
		if (!this.menu) return;
		this.menu.empty();
		if (!items.length) { this.menu.createDiv({ cls: 'wcc-ports-empty', text: 'No servers running' }); return; }
		let lastRepo = '';
		for (const it of items) {
			// portItems() is sorted by repo, then tile, then port — so a repo's rows are
			// contiguous and a heading only needs emitting when the repo changes.
			if (it.repo !== lastRepo) { this.menu.createDiv({ cls: 'wcc-ports-group', text: it.repo }); lastRepo = it.repo; }
			this.renderRow(this.menu.createDiv({ cls: 'wcc-ports-row' }), it);
		}
	}

	private renderRow(row: HTMLElement, it: PortItem): void {
		row.createSpan({ cls: 'wcc-ports-port', text: `:${it.port}` });
		row.createSpan({ cls: 'wcc-ports-path', text: it.path || '/' });
		const name = row.createSpan({ cls: 'wcc-ports-name', text: it.name, attr: { title: 'Jump to the terminal that printed this' } });
		name.addEventListener('click', (e) => { e.stopPropagation(); this.onReveal(it.tileId); this.toggle(false); });
		const peek = row.createEl('button', { cls: 'wcc-ports-peek', text: '▣', attr: { title: 'Peek inside WCC — no browser tab' } });
		peek.addEventListener('click', (e) => { e.stopPropagation(); this.onPeek(it.url); this.toggle(false); });
		// Row click opens for real; Ctrl/Cmd+click copies instead, for pasting into a script.
		row.addEventListener('click', (e) => {
			e.stopPropagation();
			if (e.ctrlKey || e.metaKey) { writeClipboardText(it.url); return; } // sync, returns void
			openExternalUrl(it.url);
			this.toggle(false);
		});
	}

	dispose(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
	}
}
```

- [ ] **Step 2: Add the styles**

Append to `app.css`, directly after the `.wcc-attn-row` rules (~line 175). These mirror the attention dropdown so the two topbar surfaces read as one system:

```css
.wcc-ports { position: relative; }
.wcc-ports-btn { background: transparent; border: 1px solid var(--background-modifier-border); color: var(--text-muted); cursor: pointer; font-size: 12px; border-radius: 6px; padding: 3px 9px; }
.wcc-ports-btn:hover { color: var(--text-normal); }
.wcc-ports-menu { position: absolute; right: 0; top: 28px; z-index: 1200; min-width: 300px; max-height: 60vh; overflow-y: auto; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.45); padding: 6px; }
.wcc-ports-group { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-faint); padding: 6px 8px 2px; }
.wcc-ports-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.wcc-ports-row:hover { background: var(--background-modifier-hover); }
.wcc-ports-port { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-normal); }
.wcc-ports-path { color: var(--text-muted); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcc-ports-name { color: var(--text-faint); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcc-ports-name:hover { color: var(--text-normal); text-decoration: underline; }
.wcc-ports-peek { padding: 1px 6px !important; font-size: 11px !important; }
.wcc-ports-empty { color: var(--text-faint); font-size: 12px; padding: 8px; }
```

- [ ] **Step 3: Wire it in app.ts**

Add to the import block in `src/app.ts`, after the `AttentionWidget` import (line 11). `app.ts` does not currently import from `./terminals/links`, so both lines are new — the second is temporary and Task 5 removes it:

```ts
import { PortsWidget } from './ui/ports-widget';
import { openExternalUrl } from './terminals/links';
```

The badge belongs **left of the attention badge**, but the widget must be *constructed* after `gridContainer` exists, since Task 5's peek pane mounts into it. Reserve the position first: immediately BEFORE the existing `const attention = new AttentionWidget(...)` line (~170), add a slot div. `.wcc-topbar` is `display: flex`, so the slot simply holds its place in the row.

```ts
		const portsSlot = topBar.createDiv({ cls: 'wcc-ports-slot' });
```

Then, directly after the `const gridContainer = terminalRoot.createDiv({ cls: 'wcc-grid-container' });` line (~186), add:

```ts
		// Ports list reads whichever grid is ACTIVE, same closure trick as the attention queue.
		const ports = new PortsWidget(
			() => activeGrid.portItems(),
			(tileId) => activeGrid.revealTile(tileId),
			(url) => openExternalUrl(url), // replaced by the peek pane in the next task
		);
		ports.render(portsSlot); // the slot reserved above the grid — keeps it left of ⚠
		window.addEventListener('beforeunload', () => ports.dispose());
```

- [ ] **Step 4: Verify**

Run: `npx vitest run`
Expected: PASS, whole suite unchanged.

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ports-widget.ts src/app.ts app.css
git commit -m "feat(ports): topbar dev-server list grouped by repo"
```

---

### Task 5: In-app peek pane

**Files:**
- Create: `src/ui/peek-pane.ts`
- Modify: `app.css` — append after the `.wcc-ports-*` block
- Modify: `src/app.ts` — the `PortsWidget` wiring added in Task 4

**Interfaces:**
- Consumes: `openExternalUrl` from `src/terminals/links.ts`.
- Produces: `class PeekPane { mount(parent: HTMLElement): void; show(url: string): void; close(): void; dispose(): void }`

- [ ] **Step 1: Write the pane**

Create `src/ui/peek-pane.ts`:

```ts
import { openExternalUrl } from '../terminals/links';

/** A single reusable <webview> docked over the right of the stage. There is exactly ONE pane:
 *  peeking another URL swaps its src, so peeking can never pile up the way browser tabs do.
 *
 *  It overlays the stage rather than splitting the layout — a real split resizes every tile and
 *  drives xterm's fit path (see fit-throttle) on every open and close.
 *
 *  Guests are already hardened in electron/main.ts (web-contents-created): window.open and
 *  target=_blank go to the real browser, and non-web protocols are dropped. */
export class PeekPane {
	private el: HTMLElement | null = null;
	private view: HTMLElement | null = null; // <webview>
	private urlEl: HTMLElement | null = null;
	private url = '';
	private onKey: ((e: KeyboardEvent) => void) | null = null;

	mount(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'wcc-peek' });
		this.el.style.display = 'none';
		const head = this.el.createDiv({ cls: 'wcc-peek-head' });
		this.urlEl = head.createSpan({ cls: 'wcc-peek-url' });
		const btns = head.createDiv({ cls: 'wcc-peek-btns' });
		const reload = btns.createEl('button', { text: '⟳', attr: { title: 'Reload' } });
		reload.addEventListener('click', (e) => { e.stopPropagation(); this.reload(); });
		const pop = btns.createEl('button', { text: '⧉', attr: { title: 'Open in browser' } });
		pop.addEventListener('click', (e) => { e.stopPropagation(); if (this.url) openExternalUrl(this.url); });
		const close = btns.createEl('button', { text: '×', attr: { title: 'Close (Esc)' } });
		close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

		// createElement, not createDiv: <webview> is a custom element, enabled by webviewTag in
		// electron/main.ts. Created once and reused for every peek.
		const view = document.createElement('webview');
		view.className = 'wcc-peek-view';
		view.setAttribute('allowpopups', ''); // so main's window-open handler fires and routes to the browser
		this.el.appendChild(view);
		this.view = view;

		// Esc closes — but only when focus is OUTSIDE the guest. A focused webview swallows keys
		// before the host sees them (main.ts mirrors F11/Ctrl+digit for exactly this reason), so
		// the × button is the reliable close once you have clicked into the page.
		this.onKey = (e) => { if (e.key === 'Escape' && this.isOpen()) this.close(); };
		document.addEventListener('keydown', this.onKey);
	}

	private isOpen(): boolean { return !!this.el && this.el.style.display !== 'none'; }

	show(url: string): void {
		if (!this.el || !this.view) return;
		this.url = url;
		this.urlEl?.setText(url);
		this.view.setAttribute('src', url);
		this.el.style.display = 'flex';
	}

	private reload(): void {
		// Re-setting src is enough and avoids depending on the webview's own reload() typing.
		if (this.view && this.url) this.view.setAttribute('src', this.url);
	}

	close(): void {
		if (!this.el || !this.view) return;
		this.el.style.display = 'none';
		// Drop the page so a peeked dev server is not left polling/socketing in the background.
		this.view.setAttribute('src', 'about:blank');
		this.url = '';
	}

	dispose(): void {
		if (this.onKey) document.removeEventListener('keydown', this.onKey);
		this.onKey = null;
	}
}
```

- [ ] **Step 2: Add the styles**

Append to `app.css` after the `.wcc-ports-*` block:

```css
.wcc-peek { position: absolute; top: 0; right: 0; bottom: 0; width: 40%; min-width: 360px; z-index: 1100; display: flex; flex-direction: column; background: var(--background-primary); border-left: 1px solid var(--background-modifier-border); box-shadow: -8px 0 28px rgba(0,0,0,.45); }
.wcc-peek-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--background-modifier-border); background: var(--background-secondary); }
.wcc-peek-url { flex: 1 1 auto; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcc-peek-btns { display: flex; gap: 4px; }
.wcc-peek-view { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }
```

- [ ] **Step 3: Point the widget's peek action at the pane**

In `src/app.ts`, add the import beside the `PortsWidget` one:

```ts
import { PeekPane } from './ui/peek-pane';
```

Replace the Task 4 wiring block with:

```ts
		// Ports list reads whichever grid is ACTIVE, same closure trick as the attention queue.
		const peek = new PeekPane();
		peek.mount(gridContainer); // .wcc-grid-container is position:relative — the overlay's anchor
		const ports = new PortsWidget(
			() => activeGrid.portItems(),
			(tileId) => activeGrid.revealTile(tileId),
			(url) => peek.show(url),
		);
		ports.render(topBar);
		window.addEventListener('beforeunload', () => { ports.dispose(); peek.dispose(); });
```

Task 4 added `import { openExternalUrl } from './terminals/links';` to `app.ts` solely for that placeholder callback. Delete that import line now — nothing else in `app.ts` uses it. (`noUnusedLocals` is off in `tsconfig.json`, so the typecheck will not catch it for you; leaving it behind is dead code, not a build failure.)

- [ ] **Step 4: Verify**

Run: `npx vitest run`
Expected: PASS, whole suite.

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no output. If `<webview>` trips the typecheck, `document.createElement('webview')` returns `HTMLElement`, which is what the field is typed as — do not add a `webview` JSX/global declaration.

- [ ] **Step 5: Commit**

```bash
git add src/ui/peek-pane.ts src/app.ts app.css
git commit -m "feat(ports): peek a dev server inside WCC instead of opening a tab"
```

---

## Manual verification (user-run only)

Per the project rules, the implementer never builds, installs, or launches the app. When the user next builds and runs WCC themselves, these are the things to look at:

1. Start a dev server in one terminal — the topbar shows `⇢ 1`, and the row names that terminal under its repo heading.
2. Start a second server in another worktree — both rows appear under their own repo headings, sorted by port within a terminal.
3. Click a row — the page opens in Chrome. Ctrl+click — the URL lands on the clipboard.
4. Click `▣` — the page renders in the right-hand pane; `▣` on a different row swaps that same pane rather than adding another.
5. Click the terminal name — the grid centres (or un-hides) the terminal that printed it.
6. Close that terminal — its rows disappear from the list.
7. Restart a terminal with `⟳` — its rows survive, because the dev server behind it did.
