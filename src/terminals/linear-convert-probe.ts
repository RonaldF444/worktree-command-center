import { SessionBridge } from './session-bridge';
import { stripAnsi } from './usage-parse';
import * as fs from 'fs';
import * as path from 'path';

export interface LinearConvertProbeOpts { sidecarPath: string; cwd: string; }
export interface ProposedIssue { title: string; description: string; }
export interface CreatedIssue { title: string; url?: string; ok: boolean; error?: string; }

const CJB_TEAM = 'CJBrothers';
const CJB_TEAM_ID = '0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5';

export function buildProposePrompt(notePath: string): string {
  return (
    `Read the note at ${notePath}. Split it into the SMALLEST sensible set of actionable Linear ` +
    'issues — often just one; more only if it clearly contains distinct tasks. Output ONLY a JSON ' +
    'array of objects {"title": string, "description": string}: title concise, description the ' +
    'relevant note context. No preamble, no explanation, no code fences.'
  );
}

export function buildCreatePrompt(issuesPath: string): string {
  return (
    `Read the JSON array of issues at ${issuesPath}. For EACH issue, create a Linear issue in the ` +
    `"${CJB_TEAM}" team (id ${CJB_TEAM_ID}) using the available Linear tool, with its title and ` +
    'description. Output ONLY a JSON array with one object per issue: {"title": string, "url": ' +
    'string, "ok": true} on success, or {"title": string, "ok": false, "error": string} on ' +
    'failure. No preamble, no explanation, no code fences.'
  );
}

/** Strip ANSI, slice the first '[' … last ']', JSON.parse; [] if absent/malformed/non-array. */
export function parseIssuesJson(raw: string): unknown[] {
  const t = stripAnsi(raw);
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try { const p = JSON.parse(t.slice(start, end + 1)); return Array.isArray(p) ? p : []; }
  catch { return []; }
}

/** Two one-shot headless `claude -p` calls (propose / create), input via temp file, tool-scoped. */
export class LinearConvertProbe {
  private seq = 0;
  constructor(private opts: LinearConvertProbeOpts) {}

  private run(input: string, prompt: (p: string) => string, tool: string, timeoutMs: number): Promise<unknown[]> {
    const tmp = path.join(this.opts.cwd, `.cos-linear-${Date.now()}-${this.seq++}.json`);
    return new Promise<unknown[]>((resolve, reject) => {
      try { fs.writeFileSync(tmp, input, 'utf8'); }
      catch (e) { reject(e instanceof Error ? e : new Error('convert: temp write failed')); return; }
      const cleanup = (): void => { try { fs.unlinkSync(tmp); } catch { /* gone */ } };
      const bridge = new SessionBridge(
        this.opts.sidecarPath, this.opts.cwd, 'claude',
        ['-p', prompt(tmp), '--output-format', 'text', '--allowedTools', tool], {},
      );
      let buf = '';
      let done = false;
      const finish = (fn: () => void): void => { if (done) return; done = true; window.clearTimeout(timer); cleanup(); fn(); };
      const timer = window.setTimeout(() => finish(() => { bridge.kill(); reject(new Error('convert timed out')); }), timeoutMs);
      bridge.onData((d) => { buf += d; });
      bridge.onExit(() => finish(() => resolve(parseIssuesJson(buf))));
      bridge.start();
    });
  }

  async propose(noteText: string): Promise<ProposedIssue[]> {
    if (noteText.trim() === '') return [];
    const rows = await this.run(noteText, buildProposePrompt, 'Read', 60000);
    return rows
      .filter((r): r is ProposedIssue =>
        !!r && typeof (r as ProposedIssue).title === 'string' && typeof (r as ProposedIssue).description === 'string')
      .map((r) => ({ title: r.title, description: r.description }));
  }

  async create(issues: ProposedIssue[]): Promise<CreatedIssue[]> {
    if (!issues.length) return [];
    const rows = await this.run(JSON.stringify(issues), buildCreatePrompt, 'mcp__linear-cjb__save_issue', 120000);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof (r as Record<string, unknown>).title === 'string')
      .map((r) => ({
        title: String(r.title),
        url: typeof r.url === 'string' ? r.url : undefined,
        ok: r.ok === true,
        error: typeof r.error === 'string' ? r.error : undefined,
      }));
  }
}
