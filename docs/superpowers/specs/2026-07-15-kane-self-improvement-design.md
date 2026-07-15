# Kane Self-Improvement — design

**Date:** 2026-07-15
**Goal:** Kane may improve his own app and build standalone tools when he sees a concrete
need — rarely, usefully, announced afterwards — without changing his overseer stance in
any other way.

## The rule (system-prompt section)

Appended to `godSystemPrompt` only when configured, titled
"SELF-IMPROVEMENT (the one standing exception to acting-only-on-request)":

- **What:** build integrations/capabilities the floor shows a CONCRETE, recurring need
  for. The bar: the user would use it weekly. Unsure → ask in the console instead.
  Never speculative features or cosmetics; at most one in flight; days apart.
- **How:** git worktree of the source repo (never the primary checkout), follow repo
  conventions, `npm test`, merge to main locally only when green. Never `git push`,
  never touch `private/`, never run the app or `npm run install-local` (the installer
  kills every session on the floor, Kane included).
- **Tools:** standalone utilities go in a dedicated tools dir; prefer a small tool over
  an app change when it serves the same need.
- **Announce:** `cos-coord note "Kane: built <thing> — npm run install-local to get it"`
  plus a summary in his console. The user decides when to reinstall.
- **Stance:** everything else UNCHANGED — no running the floor, no unprompted actions.

## Configuration

`config.json` (userData): `god: { sourceRepo: "<path to the app's source repo>",
toolsDir?: "<path>" }` — parsed tolerantly by `parseGodSelfImprove` (sourceRepo
required; toolsDir defaults to `<home>/kane-tools`). Absent/invalid → the prompt section
is omitted entirely and Kane behaves exactly as before (public-clone default). The
packaged app cannot infer its own source location, hence config.

Threading: `app.ts` (parse + default) → `GridDeps.godSelfImprove` →
`GodConsoleOpts.selfImprove` (primary + duplicates) → `godSystemPrompt`.

## Permissions

With self-improvement configured, Kane's scoped `settings.json` pre-allows `Edit`,
`Write`, `Bash(git:*)`, `Bash(npm:*)`, `Bash(node:*)` alongside the existing
`Bash(cos-coord:*)` — otherwise "he builds it and lets you know" would stall on a
permission prompt per file edit. Unconfigured Kane keeps the old minimal allowlist.
Everything not listed still prompts in his console.

## Testing

- `tests/god.test.ts`: prompt section absent when unconfigured / present with paths and
  guardrail anchors when configured; stance text intact either way; `parseGodSelfImprove`
  accept/reject cases.
- Wiring is session-bound; suite green + typecheck are the gate. The user observes the
  behavior live (Kane announcing a self-built change) — no way to unit-test judgment.
