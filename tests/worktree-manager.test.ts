import { describe, it, expect } from 'vitest';
import { slugify, autoBranchName, defaultBranch, worktreePathFor, shouldRemoveWorktree } from '../src/terminals/worktree-manager';

describe('slugify', () => {
	it('makes a filesystem/branch-safe slug', () => {
		expect(slugify('feature/My Branch')).toBe('feature-my-branch');
		expect(slugify('main')).toBe('main');
	});
});

describe('autoBranchName', () => {
	it('derives wt/<base>-<n>', () => {
		expect(autoBranchName('main', 1)).toBe('wt/main-1');
		expect(autoBranchName('feature/x', 3)).toBe('wt/feature-x-3');
	});
});

describe('defaultBranch', () => {
	it('prefers main, then master, then the first listed', () => {
		expect(defaultBranch(['dev', 'main', 'x'])).toBe('main');
		expect(defaultBranch(['dev', 'master'])).toBe('master');
		expect(defaultBranch(['feature-a', 'feature-b'])).toBe('feature-a');
		expect(defaultBranch([])).toBeUndefined();
	});
});

describe('worktreePathFor', () => {
	it('places worktrees under the repo parent .claude-worktrees/<repo>/<branch-slug>', () => {
		const p = worktreePathFor('/home/dev/projects/my-app', 'my-app', 'wt/main-1');
		expect(p.replace(/\\/g, '/')).toBe('/home/dev/projects/.claude-worktrees/my-app/wt-main-1');
	});
});

describe('shouldRemoveWorktree', () => {
	it('removes only when pristine (no status changes AND no commits beyond base)', () => {
		expect(shouldRemoveWorktree('', 0)).toBe(true);
		expect(shouldRemoveWorktree(' M file.ts\n', 0)).toBe(false);
		expect(shouldRemoveWorktree('', 2)).toBe(false);
	});
});

import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { worktreeSettingsJson, worktreeSettingsPath, writeWorktreeSettings, terminalSystemPrompt } from '../src/terminals/worktree-manager';

describe('terminalSystemPrompt', () => {
	it('states identity, parallelism, and the cross-repo worktree rule', () => {
		const p = terminalSystemPrompt('my-app', 'wt/main-1', 'C:/wt/paper-trader/wt-main-1');
		expect(p).toContain('my-app');
		expect(p).toContain('wt/main-1');
		expect(p).toContain('C:/wt/paper-trader/wt-main-1');
		expect(p.toLowerCase()).toContain('same time'); // other terminals likely open concurrently
		expect(p.toLowerCase()).toContain('worktree'); // cross-repo rule references worktrees
		expect(p).toContain('git worktree add'); // tells it how to work in another repo
	});
	it('teaches the cos-coord coordination protocol', () => {
		const p = terminalSystemPrompt('my-app', 'wt/main-1', 'C:/wt/paper-trader/wt-main-1');
		expect(p).toContain('cos-coord');
		expect(p.toLowerCase()).toContain('acquire');
	});
	it('teaches the worktrees.md ledger', () => {
		const p = terminalSystemPrompt('my-app', 'wt/main-1', 'C:/wt/paper-trader/wt-main-1');
		expect(p).toContain('worktrees.md');
		expect(p.toLowerCase()).toContain('in-flight');
	});
});

describe('worktreeSettingsJson', () => {
	it('registers ready hooks AND Pre/PostToolUse Bash coord hooks', () => {
		const cfg = JSON.parse(worktreeSettingsJson('C:/p/notify-ready.cjs', 'C:/p/coord-hook.cjs')) as {
			hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
		};
		expect(Object.keys(cfg.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'Stop']);
		expect(cfg.hooks.PreToolUse[0]!.matcher).toBe('Bash');
		expect(cfg.hooks.PreToolUse[0]!.hooks[0]!.command).toContain('coord-hook.cjs');
		expect(cfg.hooks.PostToolUse[0]!.hooks[0]!.command).toContain('--release');
	});
	it('pre-approves cos-coord so agents chat without approval', () => {
		const cfg = JSON.parse(worktreeSettingsJson('C:/p/notify-ready.cjs', 'C:/p/coord-hook.cjs')) as {
			permissions: { allow: string[] };
		};
		expect(cfg.permissions.allow).toContain('Bash(cos-coord:*)');
	});
});

describe('worktreeSettingsPath', () => {
	it('lives beside the sidecar, never inside a worktree', () => {
		const p = worktreeSettingsPath('C:/app/pty-sidecar');
		expect(nodePath.resolve(p)).toBe(nodePath.resolve('C:/app/pty-sidecar/settings/worktree-settings.json'));
		// The whole point of the fix: it must not be the repo-local settings file.
		expect(p).not.toContain('.claude');
		expect(p).not.toContain('settings.local.json');
	});
});

describe('writeWorktreeSettings', () => {
	it('writes the settings file under the sidecar dir and leaves the worktree untouched', () => {
		const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wcc-settings-'));
		const sidecarDir = nodePath.join(tmp, 'pty-sidecar');
		const worktree = nodePath.join(tmp, 'worktree');
		fs.mkdirSync(worktree, { recursive: true });

		const written = writeWorktreeSettings(sidecarDir, 'C:/p/notify-ready.cjs', 'C:/p/coord-hook.cjs');

		expect(written).toBe(worktreeSettingsPath(sidecarDir));
		expect(fs.existsSync(written)).toBe(true);
		const cfg = JSON.parse(fs.readFileSync(written, 'utf8')) as { permissions: { allow: string[] } };
		expect(cfg.permissions.allow).toContain('Bash(cos-coord:*)');
		// Regression guard: a repo may TRACK .claude/settings.local.json — we must never write it.
		expect(fs.existsSync(nodePath.join(worktree, '.claude'))).toBe(false);
	});

	it('is idempotent — rewriting does not accumulate or corrupt', () => {
		const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wcc-settings-'));
		const sidecarDir = nodePath.join(tmp, 'pty-sidecar');
		const first = fs.readFileSync(writeWorktreeSettings(sidecarDir, 'C:/p/n.cjs', 'C:/p/c.cjs'), 'utf8');
		const second = fs.readFileSync(writeWorktreeSettings(sidecarDir, 'C:/p/n.cjs', 'C:/p/c.cjs'), 'utf8');
		expect(second).toBe(first);
	});
});
