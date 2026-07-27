import type { TerminalsGrid } from './terminals/terminals-grid';

/** Extra env for spawned claude sessions, resolved per workspace at spawn time. */
export type SessionEnvProvider = (ctx: { workspaceId: string }) => Record<string, string>;

/** Surface handed to the private overlay (private/index.ts) at startup.
 *  Grow this only when a private feature actually needs more. */
export interface PrivateApi {
	topBar: HTMLElement;
	/** Portal-shell slots: `above` sits above the entire terminal UI, `below` fills the
	 *  window beneath it (empty divs until an overlay uses them). `terminalRoot` wraps the
	 *  whole terminal surface so an overlay can treat it as one swappable unit. */
	shellHosts: { above: HTMLElement; terminalRoot: HTMLElement; below: HTMLElement };
	/** Hide the terminal surface (unmounts the active grid — tiles suspend, sessions live). */
	hideTerminal: () => void;
	/** Bring the terminal surface back (remounts the active grid; tiles flush + resume). */
	showTerminal: () => Promise<void>;
	/** False while an overlay has the terminal surface hidden (public shortcuts no-op then). */
	terminalVisible: () => boolean;
	activeGrid: () => TerminalsGrid;
	config: { get: () => Promise<any>; set: (c: any) => Promise<boolean> };
	/** Startup config snapshot — lets the hook read config SYNCHRONOUSLY (the hook runs
	 *  before the first mount; an async config read would race session restore). */
	initialConfig: any;
	toast: (msg: string) => void;
	promptForTopic: (title: string, placeholder: string, initial?: string, okLabel?: string) => Promise<string | null>;
	promptForConfirm: (title: string, body: string, okLabel?: string) => Promise<boolean>;
	userData: string;
	sidecarDir: string;
	/** Set the session-env provider consulted at every claude spawn. Affects future spawns only. */
	setSessionEnv: (provider: SessionEnvProvider) => void;
	activeWorkspaceId: () => string;
	/** cb fires after a workspace switch completes (new workspace already mounted). */
	onWorkspaceSwitch: (cb: (id: string) => void) => void;
	/** Dispose and recreate the usage battery probe+widget (re-reads the provider env). */
	restartUsageProbe: () => void;
	/** Ids of every open workspace (a workspace never visited this run has no grid yet —
	 *  and therefore no sessions — so restartSessions skips it naturally). */
	workspaceIds: () => string[];
	/** Restart every live session in the given workspaces in place (--continue, fresh
	 *  fallback) so a changed session env (e.g. another account) applies to ACTIVE
	 *  terminals, not just future spawns. Interrupts any in-flight turns. */
	restartSessions: (workspaceIds: string[]) => void;
}
