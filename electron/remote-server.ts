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
/* Forge & River, distilled for a phone: the desktop's warm forge-charcoal and molten gold,
   monospace for anything that names a session, and every target sized for one thumb. Tokens
   mirror app.css so the phone reads as the same tool, not a companion app. */
:root{--bg:#100f0c;--bg2:#16140f;--panel:#1b1813;--panel2:#241f17;--bd:#383128;--bd2:#524735;
--tx:#ede7d8;--mut:#a99f89;--faint:#756c5a;--gold:#d39a2e;--gold2:#efb947;--ongold:#1a1408;
--green:#48b87a;--red:#f0623a;--cyan:#6fa0c8;--yellow:#e0b53a;
--mono:'JetBrains Mono','Cascadia Code',ui-monospace,Consolas,monospace}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-text-size-adjust:100%;display:flex;flex-direction:column;overscroll-behavior:none}
header{display:flex;align-items:center;gap:6px;padding:10px 12px;background:linear-gradient(180deg,var(--bg2),var(--bg));border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:2}
.ws{font-family:var(--mono);padding:9px 13px;border-radius:8px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--mut);background:transparent;border:1px solid transparent}
.ws.on{color:var(--gold2);background:var(--panel);border-color:var(--bd2);box-shadow:inset 0 1px 0 rgba(239,185,71,.12)}
.kane{margin-left:auto;font-family:var(--mono);padding:9px 14px;border-radius:999px;font-size:12px;font-weight:700;background:var(--panel);border:1px solid var(--bd2);color:var(--mut)}
.kane.on{background:var(--gold);border-color:var(--gold2);color:var(--ongold)}
main{flex:1;overflow:auto;padding:12px 12px 4px}
/* The focused session owns the screen — it is the only one showing text, so it earns the room. */
.focus{position:relative;border:1px solid var(--bd2);border-left:3px solid var(--gold);border-radius:10px;background:var(--panel);padding:13px 14px;margin-bottom:16px;box-shadow:0 6px 20px rgba(0,0,0,.45)}
.fname{font-family:var(--mono);font-weight:700;font-size:15px;color:var(--tx);word-break:break-word}
.fmeta{font-family:var(--mono);color:var(--faint);font-size:11px;margin:3px 0 10px}
pre{margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--mut);white-space:pre-wrap;word-break:break-word;max-height:32vh;overflow:auto;border-top:1px solid var(--bd);padding-top:9px}
.empty{font-family:var(--mono);color:var(--faint);font-size:12px;padding:6px 0}
.lbl{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 2px 7px}
.sats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.sat{display:flex;align-items:center;gap:9px;min-height:52px;border:1px solid var(--bd);border-radius:9px;background:var(--panel);color:var(--tx);padding:10px 11px;text-align:left}
.sat:active{background:var(--panel2);border-color:var(--bd2)}
.sat.hid{background:transparent;border-style:dashed;opacity:.6}
.sn{font-family:var(--mono);font-size:11.5px;font-weight:600;line-height:1.3;overflow:hidden;display:block;max-height:2.6em}
.dot{flex:none;width:9px;height:9px;border-radius:50%}
.d-prompt,.d-menu{background:var(--yellow);box-shadow:0 0 8px rgba(224,181,58,.55)}
.d-errored{background:var(--red);box-shadow:0 0 8px rgba(240,98,58,.5)}
.d-idle{background:var(--faint)}.d-running{background:var(--cyan)}
footer{border-top:1px solid var(--bd);background:var(--bg2);padding:9px 10px calc(9px + env(safe-area-inset-bottom))}
.bar{display:flex;gap:7px;align-items:stretch}
.bar input{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--bd2);border-radius:9px;padding:0 13px;font-size:16px;font-family:var(--mono);min-height:50px}
.bar button{border:none;border-radius:9px;min-height:50px;padding:0 16px;font-size:14px;font-weight:700;background:var(--gold);color:var(--ongold)}
.mic{background:var(--panel);border:1px solid var(--bd2);color:var(--tx);font-size:19px;min-width:56px}
.mic.rec{background:var(--red);border-color:var(--red);color:#fff}
.mic.off{opacity:.35}
.err{font-family:var(--mono);color:var(--gold2);font-size:11px;padding:5px 3px 0;min-height:16px}
.sp button{width:100%;background:transparent;border:1px dashed var(--bd2);color:var(--mut);border-radius:9px;min-height:44px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-family:var(--mono)}
#spawn{display:none;margin-top:8px}
#spawn select,#spawn input,#spawn textarea{width:100%;margin-bottom:7px;background:var(--bg);color:var(--tx);border:1px solid var(--bd2);border-radius:9px;padding:12px;font-size:16px;font-family:var(--mono)}
#spawn .go{width:100%;background:var(--gold);color:var(--ongold);border:none;border-radius:9px;min-height:50px;font-size:14px;font-weight:700}
</style></head><body>
<header id="hd"></header>
<main id="main"><div id="focus"></div><div id="sats"></div></main>
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
  else{fh='<div class="focus"><div class="empty">nothing focused — tap a session below</div></div>';}
  document.getElementById('focus').innerHTML=fh;
  // Two groups, because a hidden session is alive but OFF the stage on the desk. Mixing them
  // into one list is what made the page unreadable: you could not tell what you were looking at.
  var stage=[],hid=[],ts=(d.terminals||[]);
  for(var i=0;i<ts.length;i++){if(ts[i].id===d.centeredId)continue;(ts[i].hidden?hid:stage).push(ts[i]);}
  var out='';
  if(stage.length)out+='<div class="lbl">on stage'+(stage.length?' · swipe ‹ › to switch':'')+'</div><div class="sats">'+stage.map(sat).join('')+'</div>';
  if(hid.length)out+='<div class="lbl">hidden · tap to bring back</div><div class="sats">'+hid.map(sat).join('')+'</div>';
  if(!stage.length&&!hid.length)out='<div class="empty">no other sessions</div>';
  document.getElementById('sats').innerHTML=out;
}
function sat(t){
  return '<button class="sat'+(t.hidden?' hid':'')+'" onclick="focusTile('+t.id+')">'+
    '<span class="dot d-'+esc(t.state)+'"></span><span class="sn">'+esc(t.name)+'</span></button>';
}
document.getElementById('send').addEventListener('click',send);
document.getElementById('spbtn').addEventListener('click',toggleSpawn);
document.getElementById('spgo').addEventListener('click',spawn);
// Why the mic can't run, in the user's terms. NEVER hide the button silently: an absent
// control is indistinguishable from a broken one, and the two causes need different fixes.
function micWhy(){
  if(!SRC)return 'this browser has no speech API — use the mic on your keyboard instead';
  if(!window.isSecureContext)return 'mic needs the https:// link (tailscale serve) — you are on http://';
  return '';
}
var mb=document.getElementById('mic');
if(!CAN_MIC){
  mb.className='mic off';
  mb.addEventListener('click',function(){err(micWhy());});
  document.getElementById('f').placeholder='type — or hold your keyboard mic';
}else{mb.addEventListener('pointerdown',micDown);mb.addEventListener('pointerup',micUp);mb.addEventListener('pointercancel',micUp);}

// Swipe the stage left/right to move the spotlight, mirroring Alt+←/→ at the desk. Cycles the
// ON-STAGE sessions only — a hidden one is off the stage, so it is not in the rotation.
function step(dir){
  if(!LAST)return;
  var st=(LAST.terminals||[]).filter(function(t){return !t.hidden;});
  if(st.length<2)return;
  var i=-1;
  for(var k=0;k<st.length;k++){if(st[k].id===LAST.centeredId)i=k;}
  if(i<0)i=0;
  focusTile(st[(i+dir+st.length)%st.length].id);
}
var sx=null,sy=null;
var mainEl=document.getElementById('main');
mainEl.addEventListener('touchstart',function(e){
  if(e.touches.length!==1){sx=null;return;}
  sx=e.touches[0].clientX;sy=e.touches[0].clientY;
},{passive:true});
mainEl.addEventListener('touchend',function(e){
  if(sx===null)return;
  var t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;
  sx=null;
  // Decisive and horizontal, so scrolling the output pane never switches sessions by accident.
  if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.5)return;
  step(dx<0?1:-1);
},{passive:true});
function poll(){fetch('/api/floor?t='+T).then(function(r){return r.json();}).then(function(d){LAST=d;render(d);}).catch(function(){err('disconnected');});}
poll();setInterval(poll,2000);
</script></body></html>`;
