/** Whether to run WITHOUT GPU/hardware acceleration. Pure so it unit-tests; main.ts calls it at
 *  boot, BEFORE app.whenReady(), because Electron's disableHardwareAcceleration() only works
 *  there — which is also why flipping the flag needs an app restart.
 *
 *  Why this exists: a GPU driver reset (LiveKernelEvent 0x193, dxgkrnl, RTX 5070, 2026-09-14)
 *  killed Electron's GPU process and took the whole floor down with it. Software rendering
 *  cannot be killed by a driver hiccup, so acceleration is OFF unless explicitly re-enabled.
 *
 *  Precedence (first match wins):
 *  1. env WCC_DISABLE_GPU — '0'/'false'/'off' forces GPU ON, '1'/'true'/'on' forces GPU OFF.
 *  2. config.json `disableGpu: false` — GPU ON (the only way to opt back in persistently).
 *  3. Default: GPU OFF (stability first).
 */
export function shouldDisableGpu(envValue: string | undefined, cfg: unknown): boolean {
	const env = (envValue ?? '').trim().toLowerCase();
	if (env === '0' || env === 'false' || env === 'off') return false;
	if (env === '1' || env === 'true' || env === 'on') return true;
	const disableGpu = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).disableGpu : undefined;
	if (disableGpu === false) return false;
	return true;
}
