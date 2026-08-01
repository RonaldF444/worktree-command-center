# Phone Voice Input — Design

> Status: approved design, pre-implementation. Date: 2026-07-31.
> Extends [2026-06-18-phone-floor-view-design.md](2026-06-18-phone-floor-view-design.md), which
> shipped the phone floor and deliberately left "sending arbitrary input from the phone" out of v1.

## 1. Goal

Tap a terminal on the phone floor and **speak into it**: hold a mic button, talk, release, review the
transcript, send. The words arrive in that Claude session exactly as if typed at the desk. When the
browser can't give us a microphone, the same row is still a text field — where the phone keyboard's
own dictation works — so the feature degrades instead of breaking.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Phone | **iPhone / iOS Safari.** Android is not a target; nothing here excludes it. |
| Secure context | **`tailscale serve --bg 7420`.** A real `*.ts.net` cert fronts the existing HTTP server. Browsers refuse microphone access outside a secure context, so this is a hard prerequisite for voice — not a nicety. |
| Speech engine | **`webkitSpeechRecognition` in the page.** No audio leaves the phone for our servers; Apple performs the recognition. No API key, no cost, no new dependency. |
| Send gesture | **Release fills the field; a tap sends.** NOT auto-send — see §6. |
| Fallback | Mic hidden unless `window.isSecureContext && 'webkitSpeechRecognition' in window`. The text field is always present; iOS keyboard dictation works there over plain HTTP. |
| Scope | Terminal tiles **and Kane** (`id:KANE_ID`, i.e. `-1` — see `electron/remote-actions.ts`). Kane gets the talk button + compose row; the 📱 Remote control button stays tile-only (`id>=0`) — he has no Claude-remote-control toggle. *Superseded 2026-07-31: the original design shipped with Kane excluded; a follow-up task lifted the input-side exclusion. See task-6-report.md.* |
| Tailscale setup | **Manual, one-time.** WCC detects and displays, never configures. |

## 3. Architecture

Four small changes. No new process, port, or dependency.

### 3.1 Transport — `tailscale serve` (no code)

`tailscale serve --bg 7420` proxies `https://<machine>.<tailnet>.ts.net/` to `127.0.0.1:7420`.
The Node server keeps listening on `0.0.0.0:7420` exactly as today; the HTTP URLs keep working for
read-only use. Only the URL the phone opens changes.

Requires MagicDNS and HTTPS Certificates enabled in the tailnet admin console.

### 3.2 Access panel — `electron/remote-net.ts` + the 📱 panel

Add a pure `httpsUrlFor(dnsName: string | null, token: string): string | null` — returns
`https://<dnsName>/?t=<token>` with any trailing dot stripped from the MagicDNS name, or `null` when
there is no name.

The main process reads `Self.DNSName` from `tailscale status --json` once at startup (spawn, 2s
timeout, failure is non-fatal and yields `null`) and includes it in the existing `remote:info` IPC
payload. The 📱 panel renders, above the existing URL list:

- the HTTPS URL, labelled "voice-capable", when a DNS name was found;
- otherwise a one-line hint naming the `tailscale serve --bg 7420` command.

A panel that shows only `http://` URLs while advertising voice is a footgun; this is what makes the
working URL discoverable.

### 3.3 A third action — `{type:'input', id, text}`

**`electron/remote-actions.ts` (new, pure):**

```ts
export type RemoteAction =
  | { type: 'remote'; id: number }
  | { type: 'spawn'; repo: string; base: string | null; task: string }
  | { type: 'input'; id: number; text: string };

/** Validate + normalize a phone-submitted action. null = reject (ignored by the renderer). */
export function parseRemoteAction(raw: unknown): RemoteAction | null;
```

Rules: unknown or missing `type` → `null`; `input` requires an integer `id >= 0` and a `text` that is
non-empty after trimming and at most `MAX_INPUT` (4000) characters; `text` is returned trimmed with
CR/LF collapsed to spaces, so a dictated newline can never submit early or split into two messages.
`remote` and `spawn` keep their current behaviour, now expressed in one place.

**`terminals-grid.ts`:** `sendToId(id: number, text: string): void` — finds the tile among
`this.tiles`/`this.hidden`, returns silently if absent (closed since the phone's last poll), else
calls the tile's existing `sendLine(text)`. That method already writes the text and the Enter as
separate ticks, because bundling `text\r` into one PTY write makes Claude treat the newline as pasted
— it lands in the box unsent. Reusing `sendLine` inherits that fix; this design does not re-implement it.

**`app.ts`:** route the new type in the existing `onRemoteAction` handler.

### 3.4 Phone UI — `MOBILE_HTML` in `electron/remote-server.ts`

Cards stay scannable. Tapping a card toggles a compose row for that terminal only:

```
[ text field ................. ] [ 🎤 ] [ Send ]
```

- `pointerdown` on 🎤 starts recognition (`lang='en-US'`, `interimResults=true`, `continuous=false`);
  `pointerup`/`pointercancel` stops it. The button shows a recording state while held.
- Interim transcripts stream into the field; the final replaces it. The field stays editable.
- Send `POST`s `{type:'input', id, text}` and clears the field.
- The 🎤 is omitted entirely unless `window.isSecureContext && 'webkitSpeechRecognition' in window`.
- `onerror` renders the reason inline under the row (`not-allowed` → "mic permission denied",
  `no-speech` → "didn't catch that", anything else → the raw code) and leaves typed text intact.

## 4. Data flow

```
iPhone (https://<host>.ts.net)
  hold 🎤 → webkitSpeechRecognition → transcript in field → tap Send
  POST /api/action?t=<token>  {type:'input', id, text}
     ↓ token check, 100KB body cap (both already in place)
  parseRemoteAction(body) → null ? drop : webContents.send('remote:action', action)
     ↓
  app.ts onRemoteAction → grid.sendToId(id, text) → tile.sendLine(text)
     ↓
  Claude session receives the message
     ↓
  next 2s GET /api/floor → the card's output shows it landed
```

## 5. Error handling

| Case | Behaviour |
| --- | --- |
| Bad/missing token | 401, unchanged |
| Malformed body | 400, unchanged |
| Action fails validation | Dropped in main; renderer never sees it |
| Tile closed since last poll | `sendToId` no-ops; the next poll shows the card is gone |
| Tailscale down / no DNS name | `httpsUrlFor` → `null`; panel shows the setup hint; page is text-only |
| Page opened over HTTP | No mic rendered; text field + keyboard dictation still work |
| Speech API error | Inline message on the card; typed text preserved |
| Session mid-turn | Allowed — Claude queues it. The state badge already shows `running`. |

No acknowledgement protocol. The 2-second poll is the feedback loop, and it is the same one the
existing actions rely on.

## 6. Why not auto-send

Releasing the mic could post immediately, which is more hands-free. It is not the default because
these sessions run with `--dangerously-skip-permissions`: a garbled transcript reaching a working
agent is expensive to undo, and dictation errors are silent. One tap buys a read-through. Flipping
this is a one-line change in the release handler if it proves annoying in practice.

## 7. Testing

**`tests/remote-actions.test.ts`** — `parseRemoteAction`: each valid shape round-trips; unknown type,
missing id, negative/non-integer id, empty and whitespace-only text, and over-cap text are all
rejected; embedded CR/LF collapse to spaces; text is trimmed.

**`tests/remote-net.test.ts`** (extend) — `httpsUrlFor`: builds the URL, strips a trailing dot from
the MagicDNS name, returns `null` with no name.

The HTTP server, IPC bridge, mobile page, `tailscale serve`, and iOS Safari's speech behaviour are
integration surfaces with no local harness — verified by the user on the phone, the same division the
phone-floor spec drew.

**Unverifiable from the dev machine:** whether iOS Safari's `webkitSpeechRecognition` performs
acceptably (it is documented to stop on pauses and to re-prompt for permission). The text-field
fallback exists precisely so a disappointing answer costs nothing.

## 8. Out of scope

Auto-send; Approve/Deny buttons for permission prompts; uploading audio for server-side
transcription (Whisper et al.); Android tuning; automating `tailscale serve`;
cross-workspace floor; changing the read-only floor view itself; duplicate Kane consoles
(`extraKanes`) on the floor — only the primary Kane is reachable from the phone.
