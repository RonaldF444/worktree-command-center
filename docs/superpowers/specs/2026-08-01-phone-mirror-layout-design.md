# Phone Mirror Layout — Design

> Status: approved design, pre-implementation. Date: 2026-08-01.
> Replaces the phone page's flat card list from
> [2026-06-18-phone-floor-view-design.md](2026-06-18-phone-floor-view-design.md) and the per-card
> compose rows from [2026-07-31-phone-voice-input-design.md](2026-07-31-phone-voice-input-design.md).

## 1. Goal

The phone becomes a **control surface for the floor you are sitting in front of** — not a standalone
viewer. Sit at the PC, talk to the phone, move focus, spawn. The page shows what the desktop shows,
smaller: the current workspace, which terminal is focused, and one bar to talk to it.

Because you can see the real screen, the phone does not need to reproduce output for every terminal.
Only the focused one shows text.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Relationship to desktop | **True mirror.** Tapping a workspace or a terminal moves the desk. One workspace on screen at a time — whichever the desk shows. |
| Output | **Focused terminal only.** Satellites show name + state dot. Cuts the 2s poll payload ~12×. |
| Kane | A **pill**, top-right. Tapping targets him for the compose bar and shows his output in the focused pane. Does NOT move the desktop — Kane is a side console there, not a tile. |
| Compose | **One bar at the bottom**, always targeting whatever is focused. Not per-card. |
| Screen budget | Terminals get the screen. No per-card buttons, no options the desk already has. |

## 3. Payload

`GET /api/floor` returns, replacing today's flat `RemoteTerminal[]`:

```ts
interface FloorState {
  workspaces: { id: string; name: string; active: boolean }[];
  centeredId: number | null;          // null = equal grid, nothing focused
  kane: { state: string } | null;     // null = no Kane console open
  terminals: {
    id: number; name: string; repo: string; branch: string;
    state: 'prompt' | 'menu' | 'errored' | 'idle' | 'running';
    remoteOn: boolean;
    output?: string;                  // ONLY on the focused terminal (and on Kane when targeted)
  }[];
  repos: string[];                    // for the spawn form
}
```

Kane leaves the `terminals` array — he was previously `unshift`ed into it with `id:-1`, which is what
made him render as a card. He keeps `KANE_ID` as an input target.

## 4. Actions

Existing `input` / `spawn` / `remote` are unchanged. Two new:

- `{ type: 'center', id }` — focus a terminal. Routes to the grid's existing manual-click path, so it
  pins and holds exactly as a desk click does; the auto-decider will not immediately yank it back.
- `{ type: 'workspace', id }` — switch workspace. Routes to `app.ts`'s existing `switchTo(id)`.

`id` for `center` must be a real tile id (`>= 0`); Kane is not centerable. `workspace` takes the
workspace id string, validated non-empty; an unknown id is a no-op at the renderer (`switchTo`
already guards).

## 5. Renderer surface

- `TerminalsGrid` gains `get centered(): number | null` and `centerById(id: number): void`
  (the latter delegating to the existing private click handler — do not reimplement pinning).
- `floorState()` returns the terminals array plus `centeredId` and `kane`, with `output` populated
  only for the centered tile. `app.ts` adds `workspaces` and `repos` before pushing.

## 6. Page layout

```
┌──────────────────────┐
│ default  Cardtsar ◉K │  workspace names (active underlined) + Kane pill
├──────────────────────┤
│ ┌──────────────────┐ │
│ │ CJB-212 PO Match │ │  focused: name, repo·branch, output
│ │ sargent·wt/dev-114│ │
│ │ › running…        │ │
│ └──────────────────┘ │
│ ┌────┐┌────┐┌────┐   │  satellites: name + state dot, tap to focus
│ │crys││pric││mcd │   │
│ │ ●  ││ ○  ││ ○  │   │
│ └────┘└────┘└────┘   │
├──────────────────────┤
│ 🎤  [ talk… ]   Send │  targets the focused terminal (or Kane)
│               + Spawn│
└──────────────────────┘
```

State dot colours reuse the existing badge palette: prompt/menu amber, errored red, idle grey,
running cyan.

## 7. What this deletes

The per-card compose rows and their machinery go away: the `OPEN`, `DRAFT` and `NAME` maps, the
per-card talk and mic buttons, and the render-suspension guard in `poll()`.

That guard existed because re-rendering `#list` wiped an in-progress field. With one compose bar
living **outside** `#list`, a re-render cannot touch it — the whole failure class disappears, along
with the `esc()`-into-attribute draft round-trip that truncated text at a quote. This redesign is a
net simplification of the page.

The name guard on `sendToId` stays: it is what stops a stale phone list delivering text into the
wrong session, and mirroring makes stale lists likelier, not rarer.

## 8. Error handling

| Case | Behaviour |
| --- | --- |
| Focused terminal closed since last poll | `sendToId` drops (name mismatch or absent); next poll re-renders without it |
| `centeredId` null | No focused pane; satellites fill the space; compose bar disabled with a hint |
| Kane targeted but no Kane console | Pill hidden entirely when `kane` is null |
| Workspace id unknown | `switchTo` no-ops |
| Send rejected | Inline error under the bar, text preserved (unchanged from current behaviour) |

## 9. Testing

`parseRemoteAction` gains cases for `center` (valid, Kane id rejected, negative rejected) and
`workspace` (valid, empty/whitespace/non-string rejected).

`TerminalsGrid` and the served page have no unit tests in this repo by design. The page has now had
three defects that passed every automated gate, so the served script must be hand-traced before
commit: tap satellite → focus moves; tap workspace → list changes; tap Kane pill → compose targets
Kane; a poll arriving mid-typing does not disturb the compose bar.

## 10. Out of scope

Rearranging tile positions from the phone; cross-workspace aggregation (one workspace at a time, per
the mirror decision); hiding/closing terminals; a `tests/mobile-page.test.ts` harness (still a
worthwhile follow-up).
