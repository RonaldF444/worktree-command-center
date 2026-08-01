import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { parseRemoteAction } from './remote-actions';

export interface RemoteServerOpts { port: number; getWindow: () => BrowserWindow | null; }

let floorState: unknown = { workspaces: [], centeredId: null, kane: null, terminals: [], repos: [] };

/** Start the phone-floor HTTP server. Returns the access token. The renderer pushes floor
 *  state via the `remote:state` IPC; phone actions are forwarded to it via `remote:action`. */
export function startRemoteServer(opts: RemoteServerOpts): { token: string } {
	const token = randomBytes(8).toString('hex');

	ipcMain.removeAllListeners('remote:state');
	ipcMain.on('remote:state', (_e, s: unknown) => { floorState = s; });

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

// A simplified MIRROR of the desktop floor, sized for a phone held next to the machine — see
// docs/superpowers/specs/2026-08-01-phone-mirror-layout-design.md. It is a control surface, not
// a standalone viewer: workspaces and the focused terminal match what is on the desk, tapping
// either moves the desk, and only the focused terminal shows any output.
//
// The script below is ES5 on purpose (it runs on the phone and lives inside a TypeScript
// template literal): `var`/`function` only, and every literal backtick and ${ must stay escaped.
// NOTHING in this repo executes this page — tsc cannot, and no test does — so trace changes by
// hand or extract the script and run it under a DOM shim before trusting it.
const MOBILE_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<title>Floor</title><style>
:root{--bg:#0e0f17;--bg2:#171925;--bd:#2a2d3e;--tx:#e3e5ee;--mut:#9aa0b4;--faint:#6b7186;--acc:#5b73ff;--yellow:#e0a92e;--red:#d2453e;--cyan:#39c5cf}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,sans-serif;font-size:15px;-webkit-text-size-adjust:100%;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:6px;padding:10px 12px;background:var(--bg2);border-bottom:1px solid var(--bd);flex-wrap:wrap}
.ws{padding:6px 11px;border-radius:999px;font-size:13px;font-weight:600;color:var(--mut);background:transparent;border:1px solid transparent}
.ws.on{color:var(--tx);background:var(--bg);border-color:var(--bd)}
.kane{margin-left:auto;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:700;background:var(--bg);border:1px solid var(--bd);color:var(--mut)}
.kane.on{background:var(--acc);border-color:var(--acc);color:#fff}
main{flex:1;overflow:auto;padding:10px 12px}
.focus{border:1px solid var(--bd);border-radius:12px;background:var(--bg2);padding:12px;margin-bottom:12px}
.fname{font-weight:700;font-size:16px}
.fmeta{color:var(--mut);font-size:12px;margin-bottom:8px}
pre{margin:0;font-size:11.5px;color:#9fb8a8;white-space:pre-wrap;word-break:break-word;max-height:34vh;overflow:auto}
.sats{display:flex;flex-wrap:wrap;gap:8px}
.sat{flex:1 1 30%;min-width:100px;border:1px solid var(--bd);border-radius:10px;background:var(--bg2);color:var(--tx);padding:10px 9px;text-align:left}
.sn{font-size:12px;font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-top:7px}
.d-prompt,.d-menu{background:var(--yellow)}.d-errored{background:var(--red)}.d-idle{background:var(--mut)}.d-running{background:var(--cyan)}
footer{border-top:1px solid var(--bd);background:var(--bg2);padding:8px 10px calc(8px + env(safe-area-inset-bottom))}
.bar{display:flex;gap:6px;align-items:center}
.bar input{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:12px;font-size:16px}
.bar button{border:none;border-radius:10px;padding:12px 14px;font-size:15px;font-weight:600;background:var(--acc);color:#fff}
.mic{background:var(--bg);border:1px solid var(--bd);color:var(--tx)}
.mic.rec{background:var(--red);border-color:var(--red);color:#fff}
.err{color:var(--yellow);font-size:11px;padding:4px 2px 0;min-height:15px}
.sp{margin-top:2px}
.sp button{width:100%;background:transparent;border:1px dashed var(--bd);color:var(--mut);border-radius:10px;padding:8px;font-size:13px;font-weight:600}
#spawn{display:none;margin-top:8px}
#spawn select,#spawn input,#spawn textarea{width:100%;margin-bottom:6px;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:10px;font-size:16px}
#spawn .go{width:100%;background:var(--acc);color:#fff;border:none;border-radius:10px;padding:12px;font-size:15px;font-weight:600}
</style></head><body>
<header id="hd"></header>
<main><div id="focus"></div><div class="sats" id="sats"></div></main>
<footer>
<div class="bar"><input id="f" placeholder="talk…"/><button class="mic" id="mic">🎤</button><button id="send">Send</button></div>
<div class="err" id="err"></div>
<div class="sp"><button id="spbtn">+ Spawn</button></div>
<div id="spawn"><select id="repo"></select><input id="base" placeholder="base branch (blank = main)"/><textarea id="task" rows="2" placeholder="kickoff task…"></textarea><button class="go" id="spgo">Spawn it</button></div>
</footer>
<script>
var T=new URLSearchParams(location.search).get('t');
// Kane's synthetic id. Must match KANE_ID in electron/remote-actions.ts.
var KANE=-1;
var LAST=null,TARGET='focus',rec=null;
var SRC=window.webkitSpeechRecognition||window.SpeechRecognition;
var CAN_MIC=!!SRC&&window.isSecureContext;
function post(a){return fetch('/api/action?t='+T,{method:'POST',body:JSON.stringify(a)});}
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function err(m){document.getElementById('err').textContent=m||'';}
function centered(d){var ts=(d&&d.terminals)||[];for(var i=0;i<ts.length;i++){if(ts[i].id===d.centeredId)return ts[i];}return null;}
// What the compose bar is aimed at: Kane while his pill is lit, otherwise the focused tile.
// The name rides along because sendToId drops a message whose name does not match the tile it
// finds — ids are workspace-scoped, and mirroring makes a stale list likelier, not rarer.
function target(){
  if(!LAST)return null;
  if(TARGET==='kane'&&LAST.kane)return {id:KANE,name:LAST.kane.name};
  var c=centered(LAST);return c?{id:c.id,name:c.name}:null;
}
function ws(id){
  if(LAST&&LAST.workspaces){for(var i=0;i<LAST.workspaces.length;i++){LAST.workspaces[i].active=LAST.workspaces[i].id===id;}render(LAST);}
  post({type:'workspace',id:id});
}
// Optimistic: repaint with the new focus immediately so a tap feels instant. Its output is
// blank until the next poll, because the desktop only sends a tail for the focused tile.
function focusTile(id){TARGET='focus';if(LAST){LAST.centeredId=id;render(LAST);}post({type:'center',id:id});}
function kane(){TARGET=TARGET==='kane'?'focus':'kane';if(LAST)render(LAST);}
function send(){
  var t=target();if(!t){err('nothing focused');return;}
  var f=document.getElementById('f'),v=(f.value||'').trim();if(!v)return;
  post({type:'input',id:t.id,text:v,name:t.name}).then(function(r){
    if(!r.ok){err('send failed ('+r.status+')');return;}
    f.value='';err('sent to '+t.name);
  }).catch(function(){err('send failed — offline?');});
}
function micDown(){
  if(!CAN_MIC)return;
  if(rec){try{rec.stop();}catch(_e){}rec=null;}
  var f=document.getElementById('f'),base=f.value?f.value+' ':'';
  err('');
  rec=new SRC();rec.lang='en-US';rec.interimResults=true;rec.continuous=false;
  rec.onresult=function(e){var s='';for(var i=0;i<e.results.length;i++){s+=e.results[i][0].transcript;}f.value=base+s;};
  rec.onerror=function(e){err(e.error==='not-allowed'?'mic permission denied':e.error==='no-speech'?'didn\\'t catch that':e.error);};
  try{rec.start();document.getElementById('mic').className='mic rec';}catch(_e){}
}
function micUp(){if(rec){try{rec.stop();}catch(_e){}rec=null;}document.getElementById('mic').className='mic';}
function toggleSpawn(){var s=document.getElementById('spawn');s.style.display=s.style.display==='block'?'none':'block';}
function spawn(){
  var r=document.getElementById('repo').value,b=document.getElementById('base').value.trim(),t=document.getElementById('task').value.trim();
  if(!t){err('spawn needs a task');return;}
  post({type:'spawn',repo:r,base:b||null,task:t}).then(function(res){
    if(!res.ok){err('spawn failed ('+res.status+')');return;}
    document.getElementById('task').value='';toggleSpawn();err('spawning…');
  }).catch(function(){err('spawn failed — offline?');});
}
var repoFilled=false;
// Repaints the header, the focused pane and the satellites. The compose bar deliberately lives
// OUTSIDE all three: a poll can then never wipe what you are typing or orphan a live recognizer,
// which is the entire failure class the old per-card compose rows kept falling into.
function render(d){
  if(!repoFilled&&(d.repos||[]).length){document.getElementById('repo').innerHTML=d.repos.map(function(r){return '<option>'+esc(r)+'</option>';}).join('');repoFilled=true;}
  var h=(d.workspaces||[]).map(function(w){return '<button class="ws'+(w.active?' on':'')+'" onclick="ws(\\''+esc(w.id)+'\\')">'+esc(w.name)+'</button>';}).join('');
  if(d.kane)h+='<button class="kane'+(TARGET==='kane'?' on':'')+'" onclick="kane()">◉ Kane</button>';
  document.getElementById('hd').innerHTML=h;
  var c=centered(d),fh;
  if(TARGET==='kane'&&d.kane){fh='<div class="focus"><div class="fname">Kane</div><div class="fmeta">overseer · talking to him</div><pre>'+esc(d.kane.output||'')+'</pre></div>';}
  else if(c){fh='<div class="focus"><div class="fname">'+esc(c.name)+'</div><div class="fmeta">'+esc(c.repo)+' · '+esc(c.branch)+'</div><pre>'+esc(c.output||'')+'</pre></div>';}
  else{fh='<div class="focus"><div class="fmeta">nothing focused — tap a terminal below</div></div>';}
  document.getElementById('focus').innerHTML=fh;
  document.getElementById('sats').innerHTML=(d.terminals||[]).filter(function(t){return t.id!==d.centeredId;}).map(function(t){
    return '<button class="sat" onclick="focusTile('+t.id+')"><span class="sn">'+esc(t.name)+'</span><span class="dot d-'+esc(t.state)+'"></span></button>';
  }).join('');
}
document.getElementById('send').addEventListener('click',send);
document.getElementById('spbtn').addEventListener('click',toggleSpawn);
document.getElementById('spgo').addEventListener('click',spawn);
var mb=document.getElementById('mic');
if(!CAN_MIC){mb.style.display='none';document.getElementById('f').placeholder='type — or use your keyboard mic';}
else{mb.addEventListener('pointerdown',micDown);mb.addEventListener('pointerup',micUp);mb.addEventListener('pointercancel',micUp);}
function poll(){fetch('/api/floor?t='+T).then(function(r){return r.json();}).then(function(d){LAST=d;render(d);}).catch(function(){err('disconnected');});}
poll();setInterval(poll,2000);
</script></body></html>`;
