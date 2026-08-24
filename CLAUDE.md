# worktree-command-center — floor rules

## Installing the app (`npm run install-local`) — DANGEROUS
The installed app is the PARENT of every live Claude terminal on this machine.
`install-local` force-kills it (`taskkill /F`), so one install ends every session
in every workspace mid-turn. This happened twice on 2026-08-23 and took down the
whole floor both times.

- NEVER run `npm run install-local` (or launch a `* Setup *.exe`) without Ronald's
  explicit approval IN THE CURRENT CONVERSATION. "Build it" or an old standing task
  is NOT approval to install.
- Building and packaging are always fine. Only the INSTALL step is gated.
- After Ronald's OK, run it with the env var `WCC_INSTALL_OK=1` — the script refuses
  otherwise while the app is running.
- Announce the install on the coordination board BEFORE running it, so the other
  terminals' operator knows the floor is about to blink.
