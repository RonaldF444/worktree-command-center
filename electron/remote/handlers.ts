import type { HandlerTable } from './gateway';
import type { RendererRpc } from './renderer-rpc';
import { FORWARDED_CHANNELS, parseTileInvoke } from '../remote-actions';

export interface HandlerDeps { rpc: RendererRpc; readConfig: () => unknown; }

/** config.json holds more than the browser needs (linearConvert credentials, Kane's self-improve
 *  paths). Only these keys ever leave the machine. */
export const CONFIG_PUBLIC_KEYS = ['repos', 'workspaces', 'activeWorkspace', 'theme'] as const;

/** The whole set of channels a logged-in browser may invoke. Anything not in here answers
 *  'unknown channel' at the gateway. Every forwarded channel is validated HERE (main) before it
 *  crosses IPC — the renderer trusts what arrives on remote:invoke. */
export function createRemoteHandlers(deps: HandlerDeps): HandlerTable {
	const table: HandlerTable = {
		'config:get': async () => {
			const cfg = (deps.readConfig() ?? {}) as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const k of CONFIG_PUBLIC_KEYS) if (k in cfg) out[k] = cfg[k];
			return out;
		},
	};
	for (const channel of FORWARDED_CHANNELS) {
		table[channel] = async (payload) => {
			const parsed = parseTileInvoke(channel, payload);
			if (!parsed) throw new Error('invalid payload');
			return deps.rpc.invoke(channel, parsed);
		};
	}
	return table;
}
