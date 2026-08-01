import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { parseRemoteAction } from './remote-actions';

export interface RemoteServerOpts { port: number; getWindow: () => BrowserWindow | null; }

let floorState: { terminals: unknown[]; repos: string[] } = { terminals: [], repos: [] };

/** Start the phone-floor HTTP server. Returns the access token. The renderer pushes floor
 *  state via the `remote:state` IPC; phone actions are forwarded to it via `remote:action`. */
export function startRemoteServer(opts: RemoteServerOpts): { token: string } {
	const token = randomBytes(8).toString('hex');

	ipcMain.removeAllListeners('remote:state');
	ipcMain.on('remote:state', (_e, s: typeof floorState) => { floorState = s; });

	const authed = (req: IncomingMessage): boolean => {
		try { return new URL(req.url ?? '/', 'http://x').searchParams.get('t') === token; } catch { return false; }
	};
	const json = (res: ServerResponse, code: number, body: unknown): void => {
		res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
	};

	createServer((req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		if (req.method === 'GET' && path === '/') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(MOBILE_HTML); return;
		}
		if (path.startsWith('/api/')) {
			if (!authed(req)) { json(res, 401, { error: 'bad token' }); return; }
			if (req.method === 'GET' && path === '/api/floor') { json(res, 200, floorState); return; }
			if (req.method === 'POST' && path === '/api/action') {
				let body = '';
				req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
				req.on('end', () => {
					try {
						const action = parseRemoteAction(JSON.parse(body));
						if (!action) { json(res, 400, { error: 'bad action' }); return; }
						opts.getWindow()?.webContents.send('remote:action', action);
						json(res, 200, { ok: true });
					} catch { json(res, 400, { error: 'bad body' }); }
				});
				return;
			}
			json(res, 404, { error: 'not found' }); return;
		}
		res.writeHead(404); res.end('not found');
	}).listen(opts.port, '0.0.0.0', () => console.log(`[remote] phone floor on :${opts.port}`))
		.on('error', (e) => console.error('[remote] server error:', e));

	return { token };
}

const MOBILE_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Floor</title><style>
:root{--bg:#0e0f17;--bg2:#171925;--bd:#2a2d3e;--tx:#e3e5ee;--mut:#9aa0b4;--faint:#6b7186;--acc:#5b73ff;--green:#2fae6e;--yellow:#e0a92e;--red:#d2453e;--cyan:#39c5cf}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,sans-serif;font-size:15px;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;background:var(--bg2);padding:12px 14px;border-bottom:1px solid var(--bd);font-weight:600;display:flex;justify-content:space-between;align-items:center}
#status{font-size:12px;color:var(--faint);font-weight:400}
.card{margin:10px 12px;border:1px solid var(--bd);border-radius:10px;background:var(--bg2);overflow:hidden}
.chead{display:flex;align-items:center;gap:8px;padding:10px 12px}
.nm{font-weight:600}.meta{color:var(--mut);font-size:12px}
.badge{margin-left:auto;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 9px;border-radius:999px}
.s-prompt,.s-menu{background:rgba(224,169,58,.2);color:var(--yellow)}.s-errored{background:rgba(210,69,62,.22);color:var(--red)}
.s-idle{background:rgba(154,160,180,.18);color:var(--mut)}.s-running{background:rgba(57,197,207,.18);color:var(--cyan)}
pre{margin:0;padding:8px 12px;font-size:11.5px;color:#9fb8a8;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;border-top:1px solid var(--bd)}
.rc{width:100%;border:none;border-top:1px solid var(--bd);background:transparent;color:var(--cyan);padding:11px;font-size:14px;font-weight:600;cursor:pointer}
.rc.on{color:var(--green)}
.row{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--bd)}
.row input{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:16px}
.row button{border:none;border-radius:8px;padding:10px 14px;font-size:15px;font-weight:600;background:var(--acc);color:#fff}
.mic{background:var(--bg2);border:1px solid var(--bd);color:var(--tx)}
.mic.rec{background:var(--red);color:#fff}
.err{color:var(--yellow);font-size:11px;padding:0 12px 8px}
.talk{width:100%;border:none;border-top:1px solid var(--bd);background:transparent;color:var(--mut);padding:10px;font-size:13px;font-weight:600}
.spawn{margin:14px 12px;border:1px dashed var(--bd);border-radius:10px;padding:12px}
.spawn h3{margin:0 0 8px;font-size:13px;color:var(--mut)}
.spawn select,.spawn input,.spawn textarea{width:100%;margin-bottom:8px;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:14px}
.spawn button{width:100%;background:var(--acc);color:#fff;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600}
.note{color:var(--faint);font-size:11px;text-align:center;padding:8px 12px 24px}
</style></head><body>
<header><span>🌳 Floor</span><span id="status">connecting…</span></header>
<div id="list"></div>
<div class="spawn"><h3>+ Spawn a terminal</h3>
<select id="repo"></select>
<input id="base" placeholder="base branch (blank = main)"/>
<textarea id="task" rows="2" placeholder="kickoff task…"></textarea>
<button onclick="spawn()">Spawn</button></div>
<div class="note">Tap “Talk to this terminal” to send a message. 🎤 needs the HTTPS (Tailscale serve) URL; over http:// use your keyboard’s mic.</div>
<script>
var T=new URLSearchParams(location.search).get('t');
function post(a){return fetch('/api/action?t='+T,{method:'POST',body:JSON.stringify(a)});}
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function rc(id){post({type:'remote',id:id});}
var OPEN={},DRAFT={},SRC=window.webkitSpeechRecognition||window.SpeechRecognition;
var CAN_MIC=!!SRC&&window.isSecureContext;
var rec=null,LAST=null;
function anyOpen(){for(var k in OPEN){if(OPEN[k])return true;}return false;}
function talk(id){OPEN[id]=!OPEN[id];if(LAST)render(LAST);}
function draft(id){DRAFT[id]=document.getElementById('f'+id).value;}
function send(id){
  var f=document.getElementById('f'+id),v=(f.value||'').trim();
  if(!v)return;
  post({type:'input',id:id,text:v}).then(function(){f.value='';DRAFT[id]='';});
}
function serr(id,m){var e=document.getElementById('e'+id);if(e)e.textContent=m||'';}
function micDown(id){
  if(!CAN_MIC)return;
  var f=document.getElementById('f'+id),base=f.value?f.value+' ':'';
  serr(id,'');
  rec=new SRC();rec.lang='en-US';rec.interimResults=true;rec.continuous=false;
  rec.onresult=function(e){
    var s='';for(var i=0;i<e.results.length;i++){s+=e.results[i][0].transcript;}
    f.value=base+s;DRAFT[id]=f.value;
  };
  rec.onerror=function(e){
    serr(id,e.error==='not-allowed'?'mic permission denied':e.error==='no-speech'?'didn\\'t catch that':e.error);
  };
  try{rec.start();document.getElementById('m'+id).className='mic rec';}catch(_e){}
}
function micUp(id){
  if(rec){try{rec.stop();}catch(_e){}rec=null;}
  var m=document.getElementById('m'+id);if(m)m.className='mic';
}
function spawn(){var r=document.getElementById('repo').value,b=document.getElementById('base').value.trim(),t=document.getElementById('task').value.trim();if(!t){alert('task?');return;}post({type:'spawn',repo:r,base:b||null,task:t}).then(function(){document.getElementById('task').value='';});}
var repoFilled=false;
function render(d){
  if(!repoFilled&&(d.repos||[]).length){var s=document.getElementById('repo');s.innerHTML=d.repos.map(function(r){return '<option>'+esc(r)+'</option>';}).join('');repoFilled=true;}
  document.getElementById('list').innerHTML=(d.terminals||[]).map(function(t){
    return '<div class="card"><div class="chead"><span class="nm">'+esc(t.name)+'</span>'+
      '<span class="meta">'+esc(t.repo)+' · '+esc(t.branch)+'</span>'+
      '<span class="badge s-'+esc(t.state)+'">'+esc(t.state)+'</span></div>'+
      '<pre>'+esc(t.output||'')+'</pre>'+
      (t.id>=0?'<button class="rc'+(t.remoteOn?' on':'')+'" onclick="rc('+t.id+')">'+(t.remoteOn?'📱 remote on — tap to turn off':'📱 Remote control')+'</button>':'')+
      (t.id>=0?'<button class="talk" onclick="talk('+t.id+')">'+(OPEN[t.id]?'▾ close':'💬 Talk to this terminal')+'</button>':'')+
      (t.id>=0&&OPEN[t.id]?'<div class="row"><input id="f'+t.id+'" value="'+esc(DRAFT[t.id]||'')+'" oninput="draft('+t.id+')" placeholder="'+(CAN_MIC?'hold the mic, or type':'type — or use the keyboard mic')+'"/>'+
        (CAN_MIC?'<button class="mic" id="m'+t.id+'" onpointerdown="micDown('+t.id+')" onpointerup="micUp('+t.id+')" onpointercancel="micUp('+t.id+')">🎤</button>':'')+
        '<button onclick="send('+t.id+')">Send</button></div><div class="err" id="e'+t.id+'"></div>':'')+
    '</div>';
  }).join('');
}
function poll(){fetch('/api/floor?t='+T).then(function(r){return r.json();}).then(function(d){
  LAST=d;
  document.getElementById('status').textContent=(d.terminals||[]).length+' terminals';
  // Re-rendering the list would wipe a half-dictated field, drop focus, and orphan a live
  // recognition session — so while a compose row is open, only the status line updates.
  if(!anyOpen())render(d);
}).catch(function(){document.getElementById('status').textContent='disconnected';});}
poll();setInterval(poll,2000);
</script></body></html>`;
