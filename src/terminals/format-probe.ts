import { SessionBridge } from './session-bridge';
import { stripAnsi } from './usage-parse';
import * as fs from 'fs';
import * as path from 'path';

export interface FormatProbeOpts { sidecarPath: string; cwd: string; }

/** Strict reformat-only instruction that points Claude at the note FILE. The note content never
 *  rides the command line — on Windows the sidecar runs `cmd.exe /c claude …`, which would
 *  env-expand `%VAR%` and truncate past the ~8191-char line limit. Only this short, `%`-free
 *  instruction + path are passed as args. */
export function buildFormatPrompt(notePath: string): string {
  return (
    `Read the note file at ${notePath}. Output ONLY a reformatted version of its exact contents: ` +
    'fix indentation and list nesting that became inconsistent during fast typing. Preserve every ' +
    'word, every line, and its meaning EXACTLY — do not add, remove, reword, summarize, reorder, ' +
    'or comment. No preamble, no explanation, no code fences.'
  );
}

/** Clean Claude's raw stdout into just the note text: strip ANSI, trim outer whitespace, and
 *  remove a wrapping ``` / ```md fence if Claude added one. Interior lines stay intact. */
export function parseFormatOutput(raw: string): string {
  let t = stripAnsi(raw).trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  if (m) t = m[1]!;
  return t;
}

/** Drives a one-shot headless `claude -p` to reformat note text. The note is written to a temp
 *  file inside `cwd` and Claude reads it (`--allowedTools Read` whitelists ONLY the read-only
 *  Read tool — no other tool can run, no permission gates are disabled) — keeping arbitrary note
 *  content (incl. `%` and long text) off the Windows command line. Temp file removed on exit. */
export class FormatProbe {
  private seq = 0;
  constructor(private opts: FormatProbeOpts) {}

  format(noteText: string): Promise<string> {
    if (noteText.trim() === '') return Promise.resolve(noteText);
    const tmp = path.join(this.opts.cwd, `.cos-format-${Date.now()}-${this.seq++}.md`);
    return new Promise<string>((resolve, reject) => {
      try { fs.writeFileSync(tmp, noteText, 'utf8'); }
      catch (e) { reject(e instanceof Error ? e : new Error('format: temp write failed')); return; }
      const cleanup = (): void => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } };
      const bridge = new SessionBridge(
        this.opts.sidecarPath, this.opts.cwd, 'claude',
        ['-p', buildFormatPrompt(tmp), '--output-format', 'text', '--allowedTools', 'Read'], {},
      );
      let buf = '';
      let done = false;
      const finish = (fn: () => void): void => { if (done) return; done = true; window.clearTimeout(timer); cleanup(); fn(); };
      const timer = window.setTimeout(() => finish(() => { bridge.kill(); reject(new Error('format timed out')); }), 60000);
      bridge.onData((d) => { buf += d; });
      bridge.onExit(() => finish(() => {
        const out = parseFormatOutput(buf);
        out ? resolve(out) : reject(new Error('format produced no output'));
      }));
      bridge.start();
    });
  }
}
