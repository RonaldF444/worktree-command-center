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

import { settingsLocalJson, terminalSystemPrompt } from '../src/terminals/worktree-manager';

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

describe('settingsLocalJson', () => {
	it('registers ready hooks AND Pre/PostToolUse Bash coord hooks', () => {
		const cfg = JSON.parse(settingsLocalJson('C:/p/notify-ready.cjs', 'C:/p/coord-hook.cjs')) as {
			hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
		};
		expect(Object.keys(cfg.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'Stop']);
		expect(cfg.hooks.PreToolUse[0]!.matcher).toBe('Bash');
		expect(cfg.hooks.PreToolUse[0]!.hooks[0]!.command).toContain('coord-hook.cjs');
		expect(cfg.hooks.PostToolUse[0]!.hooks[0]!.command).toContain('--release');
	});
	it('pre-approves cos-coord so agents chat without approval', () => {
		const cfg = JSON.parse(settingsLocalJson('C:/p/notify-ready.cjs', 'C:/p/coord-hook.cjs')) as {
			permissions: { allow: string[] };
		};
		expect(cfg.permissions.allow).toContain('Bash(cos-coord:*)');
	});
});
