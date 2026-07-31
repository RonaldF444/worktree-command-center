# Phone Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tap a terminal on the phone floor, hold a mic button, speak, review the transcript, and send it into that Claude session.

**Architecture:** The phone page already polls `GET /api/floor` and posts `POST /api/action` to an HTTP server in the Electron main process. This adds a third action type, `{type:'input', id, text}`, validated by a new pure module in main and routed through the renderer to the tile's existing `sendLine()`. Voice is captured in the page by `webkitSpeechRecognition`, which browsers only expose in a secure context — supplied by `tailscale serve` fronting the existing server with a real `*.ts.net` certificate.

**Tech Stack:** TypeScript, Electron 33, Node `http`, vanilla ES5 in the served page (no build step for it), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-phone-voice-input-design.md`. Read it first.
- Target phone: **iPhone / iOS Safari**. Android is not a target.
- The served page is **ES5 vanilla JS inside a template literal** — no `let`/`const`/arrow functions/template literals inside `MOBILE_HTML`, and every `` ` `` and `${` must stay escaped. Match the existing style exactly.
- **Tabs for indentation**, matching every file in this repo.
- Voice requires `tailscale serve --bg 7420` (manual, one-time, by the user). WCC detects and displays; it never configures Tailscale.
- Terminal tiles only. Kane (`id:-1`) is out of scope.
- `MAX_INPUT = 4000` characters.
- Never bundle `text\r` into one PTY write — always go through `TerminalTile.sendLine()`.
- Run the full suite with `npx vitest run`. Type-check + bundle with `npm run build`.
- **Never launch the app.** Installing is `npm run install-local`, which is silent and does not open a window. The user opens WCC themselves.

---

### Task 1: Validate phone actions in the main process

The page is token-gated, but a malformed or hostile body must never become keystrokes in a live agent session. Today `POST /api/action` forwards whatever parses as JSON straight to the renderer. This adds one pure validator and routes every action through it.

**Files:**
- Create: `electron/remote-actions.ts`
- Create: `tests/remote-actions.test.ts`
- Modify: `electron/remote-server.ts:32-40` (the `POST /api/action` handler)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseRemoteAction(raw: unknown): RemoteAction | null` and `MAX_INPUT: number`, exported from `electron/remote-actions.ts`. `RemoteAction` is the union `{type:'remote',id:number} | {type:'spawn',repo:string,base:string|null,task:string} | {type:'input',id:number,text:string}`. Task 2 relies on the `input` variant's exact field names.

- [ ] **Step 1: Write the failing test**

Create `tests/remote-actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseRemoteAction, MAX_INPUT } from '../electron/remote-actions';

describe('parseRemoteAction', () => {
	it('accepts a remote toggle', () => {
		expect(parseRemoteAction({ type: 'remote', id: 3 })).toEqual({ type: 'remote', id: 3 });
	});
	it('accepts a spawn, trimming fields and nulling a blank base', () => {
		expect(parseRemoteAction({ type: 'spawn', repo: ' sargent ', base: '   ', task: ' do it ' }))
			.toEqual({ type: 'spawn', repo: 'sargent', base: null, task: 'do it' });
	});
	it('accepts input and trims it', () => {
		expect(parseRemoteAction({ type: 'input', id: 0, text: '  ship it  ' }))
			.toEqual({ type: 'input', id: 0, text: 'ship it' });
	});
	it('collapses CR/LF so a dictated newline cannot submit early or split the message', () => {
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'one\r\ntwo\nthree' }))
			.toEqual({ type: 'input', id: 1, text: 'one two three' });
	});
	it('rejects malformed, unknown and oversized actions', () => {
		expect(parseRemoteAction(null)).toBeNull();
		expect(parseRemoteAction('hi')).toBeNull();
		expect(parseRemoteAction({ type: 'nope', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: '   ' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: -1, text: 'hi' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1.5, text: 'hi' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'x'.repeat(MAX_INPUT + 1) })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'spawn', repo: '', task: 'x' })).toBeNull();
		expect(parseRemoteAction({ type: 'remote', id: 'x' })).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/remote-actions.test.ts`
Expected: FAIL — cannot resolve `../electron/remote-actions`.

- [ ] **Step 3: Write the implementation**

Create `electron/remote-actions.ts`:

```ts
/** The actions the phone may send, validated in the MAIN process before they reach the
 *  renderer. The page is token-gated, but a typo'd or hostile body must never become a
 *  keystroke in a live Claude session — so nothing is forwarded until it parses cleanly. */
export type RemoteAction =
	| { type: 'remote'; id: number }
	| { type: 'spawn'; repo: string; base: string | null; task: string }
	| { type: 'input'; id: number; text: string };

/** Longest message accepted from the phone. Speech transcripts are short; the HTTP body cap
 *  (100KB) is far too generous for something that gets typed into an agent. */
export const MAX_INPUT = 4000;

const isTileId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Validate + normalize one action. `null` means reject: it is dropped, never forwarded. */
export function parseRemoteAction(raw: unknown): RemoteAction | null {
	if (!raw || typeof raw !== 'object') return null;
	const a = raw as Record<string, unknown>;
	if (a.type === 'remote') return isTileId(a.id) ? { type: 'remote', id: a.id } : null;
	if (a.type === 'spawn') {
		if (typeof a.repo !== 'string' || !a.repo.trim()) return null;
		if (typeof a.task !== 'string' || !a.task.trim()) return null;
		const base = typeof a.base === 'string' && a.base.trim() ? a.base.trim() : null;
		return { type: 'spawn', repo: a.repo.trim(), base, task: a.task.trim() };
	}
	if (a.type === 'input') {
		if (!isTileId(a.id) || typeof a.text !== 'string') return null;
		// A dictated "new line" must stay ONE message: a CR would submit it early, and a LF
		// would split it. Collapse both to spaces before it can reach the PTY.
		const text = a.text.replace(/[\r\n]+/g, ' ').trim();
		if (!text || text.length > MAX_INPUT) return null;
		return { type: 'input', id: a.id, text };
	}
	return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/remote-actions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Route the server's POST handler through the validator**

In `electron/remote-server.ts`, add to the imports at the top:

```ts
import { parseRemoteAction } from './remote-actions';
```

Replace the `req.on('end', …)` callback inside the `POST /api/action` branch:

```ts
					req.on('end', () => {
						try {
							const action = parseRemoteAction(JSON.parse(body));
							if (!action) { json(res, 400, { error: 'bad action' }); return; }
							opts.getWindow()?.webContents.send('remote:action', action);
							json(res, 200, { ok: true });
						} catch { json(res, 400, { error: 'bad body' }); }
					});
```

- [ ] **Step 6: Verify the whole suite and the build**

Run: `npx vitest run` — Expected: all files pass, 5 more tests than before.
Run: `npm run build` — Expected: `tsc` clean, esbuild writes `dist/main.js`, `dist/preload.js`, `dist/renderer.js`.

- [ ] **Step 7: Commit**

```bash
git add electron/remote-actions.ts electron/remote-server.ts tests/remote-actions.test.ts
git commit -m "feat(remote): validate phone actions before forwarding to the renderer"
```

---

### Task 2: Deliver phone input into a terminal

**Files:**
- Modify: `src/terminals/terminals-grid.ts` (add `sendToId`, next to the existing `toggleRemoteById`)
- Modify: `src/app.ts:31` (the `onRemoteAction` type declaration) and `src/app.ts:271-274` (the handler)

**Interfaces:**
- Consumes: the `{type:'input', id, text}` action shape from Task 1.
- Produces: `TerminalsGrid.sendToId(id: number, text: string): void`.

**Note on testing:** `TerminalsGrid` owns DOM and live PTYs and is not unit-testable in this repo — no existing test constructs it. The validation logic that guards this path is fully covered by Task 1. This task's gate is `npm run build` plus the manual check in Task 5. Do not fabricate a test that mocks the whole grid; it would assert nothing real.

- [ ] **Step 1: Add `sendToId` to the grid**

In `src/terminals/terminals-grid.ts`, directly below the existing `toggleRemoteById` method:

```ts
	/** Phone: type a line into a terminal. Goes through the tile's own sendLine, which writes
	 *  the text and the Enter on SEPARATE ticks — bundling "text\r" into one PTY write makes
	 *  Claude treat the newline as pasted, so the message lands in the box unsent. A tile that
	 *  closed since the phone's last poll is silently ignored. */
	sendToId(id: number, text: string): void {
		const tile = [...this.tiles, ...this.hidden].find((t) => t.tileId === id);
		if (!tile || tile.isJournal) return;
		(tile as TerminalTile).sendLine(text);
	}
```

- [ ] **Step 2: Widen the renderer's action type**

In `src/app.ts`, line 31, add `text?: string` to the `onRemoteAction` callback parameter:

```ts
			onRemoteAction(cb: (a: { type: string; id?: number; repo?: string; base?: string | null; task?: string; text?: string }) => void): void;
```

- [ ] **Step 3: Route the new action**

In `src/app.ts`, extend the handler at line 271:

```ts
		window.wcc.onRemoteAction((a) => {
			if (a.type === 'remote' && typeof a.id === 'number') activeGrid.toggleRemoteById(a.id);
			else if (a.type === 'spawn' && a.repo && a.task) void activeGrid.spawnFromName(a.repo, a.base ?? null, a.task);
			else if (a.type === 'input' && typeof a.id === 'number' && a.text) activeGrid.sendToId(a.id, a.text);
		});
```

- [ ] **Step 4: Verify**

Run: `npm run build` — Expected: `tsc` clean (this is the real gate — it proves `sendLine` exists on the narrowed type and the union is routed).
Run: `npx vitest run` — Expected: unchanged, all pass.

- [ ] **Step 5: Commit**

```bash
git add src/terminals/terminals-grid.ts src/app.ts
git commit -m "feat(remote): deliver phone input into a terminal via sendLine"
```

---

### Task 3: Surface the voice-capable HTTPS URL

Without this, the 📱 panel shows only `http://` URLs — which can never get a microphone — while the page advertises voice. This makes the working URL discoverable.

**Files:**
- Modify: `electron/remote-net.ts` (add `httpsUrlFor`)
- Modify: `tests/remote-net.test.ts` (extend)
- Modify: `electron/main.ts:100-106` (the `remote:info` handler)
- Modify: `src/app.ts:32` (the `remoteInfo` return type) and the panel body around `src/app.ts:284-286`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `httpsUrlFor(dnsName: string | null | undefined, token: string): string | null` from `electron/remote-net.ts`, and a new `httpsUrl: string | null` field on the `remote:info` IPC payload.

- [ ] **Step 1: Write the failing test**

Append to `tests/remote-net.test.ts` (add `httpsUrlFor` to the existing import from `../electron/remote-net`):

```ts
describe('httpsUrlFor', () => {
	it('builds the URL and strips the MagicDNS trailing dot', () => {
		expect(httpsUrlFor('desk.tail1234.ts.net.', 'abc123')).toBe('https://desk.tail1234.ts.net/?t=abc123');
	});
	it('works without a trailing dot', () => {
		expect(httpsUrlFor('desk.tail1234.ts.net', 'abc123')).toBe('https://desk.tail1234.ts.net/?t=abc123');
	});
	it('returns null when there is no name — voice is simply unavailable', () => {
		expect(httpsUrlFor(null, 'abc123')).toBeNull();
		expect(httpsUrlFor(undefined, 'abc123')).toBeNull();
		expect(httpsUrlFor('   ', 'abc123')).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/remote-net.test.ts`
Expected: FAIL — `httpsUrlFor is not a function`.

- [ ] **Step 3: Implement it**

Append to `electron/remote-net.ts`:

```ts
/** The HTTPS URL for the phone page when `tailscale serve` is fronting us, else null.
 *  Voice needs a secure context: Safari will not hand a microphone to an http:// page, so
 *  the plain-HTTP URLs above are read-only in practice. MagicDNS names arrive fully
 *  qualified with a trailing dot, which is legal in DNS but ugly in a URL. */
export function httpsUrlFor(dnsName: string | null | undefined, token: string): string | null {
	const host = (dnsName ?? '').trim().replace(/\.$/, '');
	return host ? `https://${host}/?t=${token}` : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/remote-net.test.ts`
Expected: PASS, 3 new tests.

- [ ] **Step 5: Read the MagicDNS name in main**

In `electron/main.ts`, add `execFileSync` to the existing `child_process` import (or add `import { execFileSync } from 'child_process';` if there is none), add `httpsUrlFor` to the `./remote-net` import on line 6, and define above `createWindow`:

```ts
/** This machine's MagicDNS name, for the HTTPS (voice-capable) phone URL. Best-effort: no
 *  Tailscale installed, not logged in, or a daemon still starting all yield null and the
 *  panel falls back to the setup hint. Read on each panel open rather than once at startup,
 *  because Tailscale often finishes starting after WCC does. */
function tailscaleDnsName(): string | null {
	try {
		const out = execFileSync('tailscale', ['status', '--json'], { timeout: 2000, encoding: 'utf8', windowsHide: true });
		const name = (JSON.parse(out) as { Self?: { DNSName?: string } }).Self?.DNSName;
		return typeof name === 'string' && name.trim() ? name : null;
	} catch { return null; }
}
```

Then extend the handler at line 102:

```ts
	ipcMain.handle('remote:info', () => ({
		token,
		port: REMOTE_PORT,
		urls: accessUrls(pickHosts(os.networkInterfaces(), os.hostname()), REMOTE_PORT, token),
		httpsUrl: httpsUrlFor(tailscaleDnsName(), token),
	}));
```

- [ ] **Step 6: Show it in the panel**

In `src/app.ts`, line 32, widen the declared return type:

```ts
			remoteInfo(): Promise<{ token: string; port: number; urls: string[]; httpsUrl: string | null }>;
```

In the panel body, immediately after the `wcc-phone-h` line and before the existing `wcc-phone-sub`:

```ts
				if (info.httpsUrl) {
					phonePanel.createDiv({ cls: 'wcc-phone-sub', text: '🎤 Voice-capable (HTTPS) — open this one to talk:' });
					phonePanel.createEl('div', { cls: 'wcc-phone-url', text: info.httpsUrl });
				} else {
					phonePanel.createDiv({ cls: 'wcc-phone-sub', text: 'For voice, run once:  tailscale serve --bg 7420' });
				}
```

- [ ] **Step 7: Verify**

Run: `npx vitest run` — Expected: all pass.
Run: `npm run build` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add electron/remote-net.ts electron/main.ts src/app.ts tests/remote-net.test.ts
git commit -m "feat(remote): surface the voice-capable HTTPS URL in the phone panel"
```

---

### Task 4: Mic and compose row on the phone page

**Files:**
- Modify: `electron/remote-server.ts` — the `MOBILE_HTML` template literal (CSS block, card markup in `render`, and the `<script>`)

**Interfaces:**
- Consumes: `POST /api/action` with `{type:'input', id, text}` (Task 1), delivered by Task 2.
- Produces: nothing consumed by later tasks.

**Critical detail:** `poll()` rewrites `#list` innerHTML every 2 seconds. Left alone it would erase a half-dictated field, drop focus, and orphan a live `SpeechRecognition` session. The render is therefore **suspended while any compose row is open** — status keeps updating, the card list does not.

- [ ] **Step 1: Add the CSS**

In `MOBILE_HTML`, after the existing `.rc.on{…}` rule:

```css
.row{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--bd)}
.row input{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:16px}
.row button{border:none;border-radius:8px;padding:10px 14px;font-size:15px;font-weight:600;background:var(--acc);color:#fff}
.mic{background:var(--bg2);border:1px solid var(--bd);color:var(--tx)}
.mic.rec{background:var(--red);color:#fff}
.err{color:var(--yellow);font-size:11px;padding:0 12px 8px}
.talk{width:100%;border:none;border-top:1px solid var(--bd);background:transparent;color:var(--mut);padding:10px;font-size:13px;font-weight:600}
```

`font-size:16px` on the input is deliberate — iOS Safari zooms the page when focusing any field below 16px.

- [ ] **Step 2: Add the script logic**

In the `<script>` block, after the `function rc(id){…}` line. This is ES5 on purpose — no `let`, `const`, or arrow functions:

```js
var OPEN={},DRAFT={},SRC=window.webkitSpeechRecognition||window.SpeechRecognition;
var CAN_MIC=!!SRC&&window.isSecureContext;
var rec=null;
function anyOpen(){for(var k in OPEN){if(OPEN[k])return true;}return false;}
function talk(id){OPEN[id]=!OPEN[id];poll();}
function draft(id){DRAFT[id]=document.getElementById('f'+id).value;}
function send(id){
  var f=document.getElementById('f'+id),v=(f.value||'').trim();
  if(!v)return;
  post({type:'input',id:id,text:v}).then(function(){f.value='';DRAFT[id]='';});
}
function serr(id,m){var e=document.getElementById('e'+id);if(e)e.textContent=m||'';}
function micDown(id){
  if(!CAN_MIC)return;
  var f=document.getElementById('f'+id),base=f.value?f.value+' ':'';
  serr(id,'');
  rec=new SRC();rec.lang='en-US';rec.interimResults=true;rec.continuous=false;
  rec.onresult=function(e){
    var s='';for(var i=0;i<e.results.length;i++){s+=e.results[i][0].transcript;}
    f.value=base+s;DRAFT[id]=f.value;
  };
  rec.onerror=function(e){
    serr(id,e.error==='not-allowed'?'mic permission denied':e.error==='no-speech'?'didn\\'t catch that':e.error);
  };
  try{rec.start();document.getElementById('m'+id).className='mic rec';}catch(_e){}
}
function micUp(id){
  if(rec){try{rec.stop();}catch(_e){}rec=null;}
  var m=document.getElementById('m'+id);if(m)m.className='mic';
}
```

Note the doubled backslash in `didn\\'t` — this lives inside a TypeScript template literal, so one level of escaping is consumed before the browser sees it.

- [ ] **Step 3: Render the compose row**

In `render`, replace the remote-control button line so each terminal card also gets the talk toggle and, when open, the row:

```js
      (t.id>=0?'<button class="rc'+(t.remoteOn?' on':'')+'" onclick="rc('+t.id+')">'+(t.remoteOn?'📱 remote on — tap to turn off':'📱 Remote control')+'</button>':'')+
      (t.id>=0?'<button class="talk" onclick="talk('+t.id+')">'+(OPEN[t.id]?'▾ close':'💬 Talk to this terminal')+'</button>':'')+
      (t.id>=0&&OPEN[t.id]?'<div class="row"><input id="f'+t.id+'" value="'+esc(DRAFT[t.id]||'')+'" oninput="draft('+t.id+')" placeholder="'+(CAN_MIC?'hold the mic, or type':'type — or use the keyboard mic')+'"/>'+
        (CAN_MIC?'<button class="mic" id="m'+t.id+'" onpointerdown="micDown('+t.id+')" onpointerup="micUp('+t.id+')" onpointercancel="micUp('+t.id+')">🎤</button>':'')+
        '<button onclick="send('+t.id+')">Send</button></div><div class="err" id="e'+t.id+'"></div>':'')+
```

- [ ] **Step 4: Suspend re-render while composing**

Replace `poll`:

```js
function poll(){fetch('/api/floor?t='+T).then(function(r){return r.json();}).then(function(d){
  document.getElementById('status').textContent=(d.terminals||[]).length+' terminals';
  // Re-rendering the list would wipe a half-dictated field, drop focus, and orphan a live
  // recognition session — so while a compose row is open, only the status line updates.
  if(!anyOpen())render(d);
}).catch(function(){document.getElementById('status').textContent='disconnected';});}
```

Then delete the now-duplicated status line from the top of `render`.

- [ ] **Step 5: Update the footer note**

Replace the `.note` div's text:

```html
<div class="note">Tap “Talk to this terminal” to send a message. 🎤 needs the HTTPS (Tailscale serve) URL; over http:// use your keyboard’s mic.</div>
```

- [ ] **Step 6: Verify**

Run: `npm run build` — Expected: clean. A stray backtick or `${` inside `MOBILE_HTML` shows up here as a TypeScript error.
Run: `npx vitest run` — Expected: all pass, unchanged.

- [ ] **Step 7: Commit**

```bash
git add electron/remote-server.ts
git commit -m "feat(remote): hold-to-talk mic and compose row on the phone floor"
```

---

### Task 5: Install and hand off for phone verification

Everything below this line can only be confirmed on the physical device. Do not claim the feature works before the user reports back.

**Files:** none.

- [ ] **Step 1: Full verification**

Run: `npx vitest run` — Expected: every file passes.
Run: `npm run build` — Expected: `tsc` clean.

- [ ] **Step 2: Install**

Run: `npm run install-local`
Expected: ends with `[install-local] done — installed at …`. It is silent and does **not** open a window.

- [ ] **Step 3: Hand the user the setup and test steps**

Tell them, verbatim:

1. Run once in a terminal: `tailscale serve --bg 7420`
   (needs MagicDNS and HTTPS Certificates enabled in the tailnet admin console)
2. Open WCC from the Start Menu and click 📱 in the topbar.
3. The panel should now show a `https://…ts.net/?t=…` line labelled voice-capable. If it shows the `tailscale serve` hint instead, Tailscale isn't reporting a MagicDNS name yet.
4. Open that HTTPS URL on the iPhone. Tap **💬 Talk to this terminal** on any card.
5. Hold 🎤, speak, release. The transcript should appear in the field. Tap **Send**.
6. Within ~2 seconds of closing the row, that terminal's output should show the message.

- [ ] **Step 4: Report honestly**

If the mic does not appear on the phone, the page is not in a secure context — confirm the URL begins `https://`. If it appears but recognition fails, capture the inline error text; `not-allowed` means Safari denied permission (Settings → Safari → Microphone). The text field and the iOS keyboard mic remain the working fallback either way, and that outcome is a legitimate result, not a failure of the task.

---

## Self-Review

**Spec coverage:** §3.1 transport → Task 5 step 3 (manual, as specified). §3.2 access panel → Task 3. §3.3 action type + `sendToId` + app routing → Tasks 1 and 2. §3.4 phone UI → Task 4. §5 error handling → Task 1 (validation), Task 2 (missing tile), Task 3 (`null` DNS name), Task 4 (speech errors, non-secure context). §6 confirmation tap → Task 4 step 3, Send is a separate button. §7 testing → Tasks 1 and 3 carry the pure tests; Task 5 covers the integration surface.

**Placeholder scan:** none — every step carries its literal code or command.

**Type consistency:** `parseRemoteAction`/`MAX_INPUT` (Task 1) are used with those names in Task 1 only; `sendToId(id, text)` (Task 2) matches the call in `app.ts`; `httpsUrlFor(dnsName, token)` (Task 3) matches its test and its `main.ts` call site; the page's `{type:'input',id,text}` (Task 4) matches the union defined in Task 1.

**Known gap, deliberate:** the spec's §3.2 says the MagicDNS name is read "once at startup"; this plan reads it on each panel open instead, because Tailscale is frequently still starting when WCC launches. Strictly better, same output.
