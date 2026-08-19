// Standalone Node PTY sidecar. Runs under SYSTEM node (not Obsidian's Electron)
// so node-pty's prebuilt binary matches. Protocol over stdio, newline-delimited
// JSON, base64 payloads:
//   in : {"t":"data","d":"<b64>"}  {"t":"resize","cols":N,"rows":M}
//   out: {"t":"data","d":"<b64>"}  {"t":"exit","code":N}
// Usage: node sidecar.cjs <cwd> [command] [args...]   (command default: "claude")
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  process.stdout.write(JSON.stringify({ t: 'data', d: Buffer.from('node-pty failed to load: ' + e.message + '\r\n').toString('base64') }) + '\n');
  process.stdout.write(JSON.stringify({ t: 'exit', code: 1 }) + '\n');
  process.exit(1);
}

const cwd = process.argv[2] || process.cwd();
const command = process.argv[3] || 'claude';
const extraArgs = process.argv.slice(4);

const isWin = process.platform === 'win32';
const file = isWin ? 'cmd.exe' : command;
const args = isWin ? ['/c', command, ...extraArgs] : extraArgs;

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let term;
try {
  term = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: process.env });
  // Report the PTY child's PID so the dashboard can tree-kill it on close. On Windows the
  // ConPTY child is parented to the pty host, not this sidecar, so the sidecar's own
  // taskkill /T never reaches it — the claude session (+ its MCP children) would otherwise leak.
  try { send({ t: 'pid', pid: term.pid }); } catch (_) { /* best effort */ }
} catch (e) {
  send({ t: 'data', d: Buffer.from('failed to spawn ' + command + ': ' + e.message + '\r\n').toString('base64') });
  send({ t: 'exit', code: 1 });
  process.exit(1);
}

// Idle-based "ready": when claude stops producing output (turn finished, or it's
// waiting at a question / permission prompt) emit ONE {t:'ready'} until output resumes.
// Spinners/streaming keep output flowing, so this doesn't fire mid-think.
let lastOut = Date.now();
let sawOutput = false;
let readyEmitted = false;
const IDLE_MS = 1200;
term.onData((d) => {
  send({ t: 'data', d: Buffer.from(d, 'utf8').toString('base64') });
  lastOut = Date.now();
  sawOutput = true;
  readyEmitted = false;
});
const idleTimer = setInterval(() => {
  if (sawOutput && !readyEmitted && (Date.now() - lastOut) >= IDLE_MS) {
    readyEmitted = true;
    send({ t: 'ready' });
  }
}, 400);
term.onExit(({ exitCode }) => { clearInterval(idleTimer); send({ t: 'exit', code: exitCode }); process.exit(0); });

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.t === 'data') term.write(Buffer.from(msg.d, 'base64').toString('utf8'));
    else if (msg.t === 'resize' && msg.cols > 0 && msg.rows > 0) { try { term.resize(msg.cols, msg.rows); } catch { /* ignore */ } }
  }
});
process.stdin.on('end', () => { try { term.kill(); } catch { /* ignore */ } });
