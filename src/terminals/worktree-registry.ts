import { slugify } from './worktree-manager';

/** The next collision-proof worktree branch: max existing wt/<slug(base)>-N, plus 1.
 *  Derived from REAL branches (not an in-memory counter), so reloads/second windows
 *  never regenerate an existing name. */
export function nextWorktreeBranch(existingBranches: string[], base: string): string {
  const prefix = `wt/${slugify(base)}-`;
  let max = 0;
  for (const b of existingBranches) {
    if (!b.startsWith(prefix)) continue;
    const rest = b.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;           // suffix must be purely numeric
    const n = parseInt(rest, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/** Parse `git worktree list --porcelain` into {path, branch} records. */
export function parseWorktreeList(porcelain: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = [];
  let cur: { path: string; branch: string } | null = null;
  for (const raw of String(porcelain).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: '(detached)' };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace('refs/heads/', '').trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Changed file paths from `git status --porcelain` (drops the 2-char XY + space prefix). */
export function parseStatusPorcelain(s: string): string[] {
  return String(s).split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** `git rev-list --left-right --count base...HEAD` prints "<behind>\t<ahead>". */
export function parseAheadBehind(s: string): { ahead: number; behind: number } {
  const p = String(s).trim().split(/\s+/);
  return { behind: parseInt(p[0] ?? '0', 10) || 0, ahead: parseInt(p[1] ?? '0', 10) || 0 };
}

export interface WorktreeEntry {
  repo: string;
  branch: string;
  path: string;
  terminal: string | null;   // owning terminal name, or null if no live tile maps to it
  dirtyFiles: string[];
  ahead: number;
  behind: number;
  parked: boolean;           // HEAD is an auto-park commit
  lastActivity: number;      // epoch ms
}

const PARK_PREFIX = 'wip: auto-parked';
export function parkCommitSubject(iso: string): string { return `${PARK_PREFIX} ${iso} (Worktree Command Center)`; }
export function isParkCommitSubject(subject: string): boolean { return String(subject).startsWith(PARK_PREFIX); }

export function computeState(e: WorktreeEntry): 'clean' | 'dirty' | 'ahead' | 'parked' {
  if (e.parked) return 'parked';
  if (e.dirtyFiles.length > 0) return 'dirty';
  if (e.ahead > 0) return 'ahead';
  return 'clean';
}

export function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function summarizeFiles(files: string[]): string {
  if (files.length === 0) return '';
  const shown = files.slice(0, 3);
  const extra = files.length - shown.length;
  const list = extra > 0 ? `${shown.slice(0, 2).join(', ')}, +${files.length - 2}` : shown.join(', ');
  return `${files.length} file${files.length === 1 ? '' : 's'} (${list})`;
}

/** Render the ledger: a section per repo, one line per worktree with a state badge,
 *  owner, dirty-file summary, ahead/behind, and relative last-activity. */
export function formatRegistryMarkdown(entries: WorktreeEntry[], now: number): string {
  if (entries.length === 0) return '# Worktrees\n\n_No active worktrees._\n';
  const byRepo = new Map<string, WorktreeEntry[]>();
  for (const e of entries) {
    const list = byRepo.get(e.repo) ?? [];
    list.push(e);
    byRepo.set(e.repo, list);
  }
  let out = '# Worktrees\n';
  for (const [repo, list] of byRepo) {
    out += `\n## ${repo}\n`;
    for (const e of list) {
      const st = computeState(e);
      const badge = st === 'dirty' ? '[DIRTY]' : st === 'parked' ? '[PARKED]' : st === 'ahead' ? '[ahead]' : 'clean';
      const owner = e.terminal ? `terminal "${e.terminal}"` : '(terminal closed)';
      const files = e.dirtyFiles.length ? ` · ${summarizeFiles(e.dirtyFiles)}` : '';
      const ab = (e.ahead || e.behind) ? ` · ↑${e.ahead} ↓${e.behind}` : '';
      out += `- ${e.branch}  ${badge}  ${owner}${files}${ab} · ${relAge(now - e.lastActivity)}\n`;
    }
  }
  return out;
}
