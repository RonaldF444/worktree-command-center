import type { IncomingMessage, ServerResponse } from 'http';
import { parseRemoteAction, type RemoteAction } from './remote-actions';

export interface PhoneRouteDeps { token: string; getFloor: () => unknown; onAction: (action: RemoteAction) => void; }

/** The phone floor view's routes, mounted by the browser gateway (electron/remote/gateway.ts):
 *  GET /phone (the page, no token — it is a shell), GET /api/floor and POST /api/action (token
 *  in `?t=`). Returns true when it handled the request. The page's own fetches use absolute
 *  `/api/...` paths, so serving it at /phone instead of / needs no change to MOBILE_HTML. */
export function createPhoneRoutes(deps: PhoneRouteDeps): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
	const authed = (req: IncomingMessage): boolean => {
		try { return new URL(req.url ?? '/', 'http://x').searchParams.get('t') === deps.token; } catch { return false; }
	};
	const json = (res: ServerResponse, code: number, body: unknown): void => {
		res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
	};
	return (req, res, pathname) => {
		if (req.method === 'GET' && pathname === '/phone') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(MOBILE_HTML); return true;
		}
		if (!pathname.startsWith('/api/')) return false;
		if (!authed(req)) { json(res, 401, { error: 'bad token' }); return true; }
		if (req.method === 'GET' && pathname === '/api/floor') { json(res, 200, deps.getFloor()); return true; }
		if (req.method === 'POST' && pathname === '/api/action') {
			let body = '';
			req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
			req.on('end', () => {
				try {
					const action = parseRemoteAction(JSON.parse(body));
					if (!action) { json(res, 400, { error: 'bad action' }); return; }
					deps.onAction(action);
					json(res, 200, { ok: true });
				} catch { json(res, 400, { error: 'bad body' }); }
			});
			return true;
		}
		json(res, 404, { error: 'not found' });
		return true;
	};
}

// A CAROUSEL of the floor, sized for a phone held next to the machine — see
// docs/superpowers/specs/2026-08-01-phone-mirror-layout-design.md. The focused session holds the
// middle with its output and a mic; its neighbours peek in at both edges; swipe or tap a peek to
// move the spotlight, which moves the desk too. Workspaces top-left, Kane top-right.
//
// EVERY element the script attaches a listener to is STABLE (#prev/#next/#mic/#f/#send/#spbtn/
// #spgo) — render() only rewrites innerHTML inside containers, never replaces those nodes. That
// is what keeps listeners bound and stops a 2s poll from wiping what you are typing.
//
// The script is ES5 on purpose (it runs on the phone, inside a TypeScript template literal):
// `var`/`function` only, and every literal backtick and ${ must stay escaped. NOTHING in this
// repo executes this page — tsc cannot, and no test does — so trace changes by hand or extract
// the script and run it under a DOM shim before trusting it.
export const MOBILE_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<title>Floor</title><style>
/* Forge & River, distilled: the desktop's warm forge-charcoal and molten gold, monospace for
   anything naming a session, tokens mirrored from app.css so this reads as the same tool. */
:root{--bg:#100f0c;--bg2:#16140f;--panel:#1b1813;--panel2:#241f17;--bd:#383128;--bd2:#524735;
--tx:#ede7d8;--mut:#a99f89;--faint:#756c5a;--gold:#d39a2e;--gold2:#efb947;--ongold:#1a1408;
--red:#f0623a;--cyan:#6fa0c8;--yellow:#e0b53a;
--mono:'JetBrains Mono','Cascadia Code',ui-monospace,Consolas,monospace}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-text-size-adjust:100%;display:flex;flex-direction:column;overscroll-behavior:none}
header{display:flex;align-items:center;gap:6px;padding:8px 9px;border-bottom:1px solid var(--bd);background:var(--bg2)}
#ws{display:flex;gap:5px;flex:1;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch}
.ws{flex:none;font-family:var(--mono);padding:6px 9px;border-radius:7px;font-size:11px;font-weight:600;color:var(--mut);background:transparent;border:1px solid transparent}
.ws.on{color:var(--gold2);background:var(--panel);border-color:var(--bd2)}
.pill{flex:none;font-family:var(--mono);padding:7px 11px;border-radius:7px;font-size:11px;font-weight:700;background:var(--panel);border:1px solid var(--bd2);color:var(--mut)}
.pill.on{background:var(--gold);border-color:var(--gold2);color:var(--ongold)}
/* The spotlight: a fixed slice of the screen so the satellite list below can never squeeze it
   flat — that collapse is what threw the mic up over the header. */
.stagewrap{position:relative;flex:none;height:44vh;padding:9px 9px 0}
.stage{position:relative;height:100%;border:2px solid var(--gold);border-radius:11px;background:var(--panel);padding:12px 13px 76px;overflow:hidden;box-shadow:0 8px 26px rgba(0,0,0,.5)}
.sname{font-family:var(--mono);font-weight:700;font-size:14px;word-break:break-word}
.smeta{font-family:var(--mono);color:var(--faint);font-size:10.5px;margin:3px 0 9px}
pre{margin:0;font-family:var(--mono);font-size:10.5px;line-height:1.55;color:var(--mut);white-space:pre-wrap;word-break:break-word;height:100%;overflow:auto;border-top:1px solid var(--bd);padding-top:8px}
.empty{font-family:var(--mono);color:var(--faint);font-size:11.5px}
.dot{flex:none;width:9px;height:9px;border-radius:50%}
.d-prompt,.d-menu{background:var(--yellow);box-shadow:0 0 8px rgba(224,181,58,.55)}
.d-errored{background:var(--red);box-shadow:0 0 8px rgba(240,98,58,.5)}
.d-idle{background:var(--faint)}.d-running{background:var(--cyan)}
/* The mic is the hero control: a thumb-sized circle on the focused card. It is a STABLE node
   parked over the stage, never inside render()'s innerHTML, so its listeners survive polls. */
#mic{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);width:60px;height:60px;border-radius:50%;font-size:24px;background:var(--panel2);border:2px solid var(--bd2);color:var(--tx);box-shadow:0 5px 16px rgba(0,0,0,.5);z-index:3}
#mic.rec{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 0 0 8px rgba(240,98,58,.18)}
#mic.off{opacity:.3}
/* Every other on-stage session, exactly like the satellites around the desk's centred tile.
   Scrolls, so ten sessions look the same as three. */
#others{flex:1;min-height:0;overflow-y:auto;display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;padding:9px}
.oth{display:flex;align-items:center;gap:8px;flex:1 1 calc(50% - 3px);min-width:0;min-height:44px;border:1px solid var(--bd);border-radius:8px;background:var(--panel);color:var(--tx);padding:8px 10px;text-align:left}
.oth:active{background:var(--panel2);border-color:var(--bd2)}
.on{font-family:var(--mono);font-size:10.5px;font-weight:600;line-height:1.25;overflow:hidden;max-height:2.5em}
/* Hidden sessions live behind the coordination pill — off the stage here, off the stage there. */
#coord{display:none;flex:1;min-height:0;overflow-y:auto;padding:9px;flex-direction:column;gap:6px}
#coord.open{display:flex}
.hchip{font-family:var(--mono);font-size:10.5px;padding:11px 11px;border-radius:8px;border:1px dashed var(--bd2);background:transparent;color:var(--mut);text-align:left}
.chead{font-size:10px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);padding:0 2px 2px}
footer{border-top:1px solid var(--bd);background:var(--bg2);padding:8px 10px calc(8px + env(safe-area-inset-bottom))}
.bar{display:flex;gap:6px}
.bar input{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--bd2);border-radius:9px;padding:0 12px;font-size:16px;font-family:var(--mono);min-height:46px}
.bar button{border:none;border-radius:9px;min-height:46px;padding:0 15px;font-size:13px;font-weight:700;background:var(--gold);color:var(--ongold)}
.err{font-family:var(--mono);color:var(--gold2);font-size:10.5px;padding:5px 3px 0;min-height:15px}
.sp button{width:100%;background:transparent;border:1px dashed var(--bd2);color:var(--mut);border-radius:9px;min-height:40px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;font-family:var(--mono)}
#spawn{display:none;margin-top:7px}
#spawn select,#spawn input,#spawn textarea{width:100%;margin-bottom:6px;background:var(--bg);color:var(--tx);border:1px solid var(--bd2);border-radius:9px;padding:11px;font-size:16px;font-family:var(--mono)}
#spawn .go{width:100%;background:var(--gold);color:var(--ongold);border:none;border-radius:9px;min-height:46px;font-size:13px;font-weight:700}
</style></head><body>
<header><div id="ws"></div><button class="pill" id="coordbtn" style="display:none">coord</button><button class="pill" id="kanebtn" style="display:none">kane</button></header>
<div class="stagewrap" id="strip">
<section class="stage" id="stage"></section>
<button id="mic">🎤</button>
</div>
<div id="others"></div>
<div id="coord"></div>
<footer>
<div class="bar"><input id="f" placeholder="talk…"/><button id="send">Send</button></div>
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
// The carousel rotates ON-STAGE sessions only: a hidden one is alive but off the stage at the
// desk, so it sits in the tray instead and rejoins when you bring it back.
function stageList(d){var o=[],ts=(d&&d.terminals)||[];for(var i=0;i<ts.length;i++){if(!ts[i].hidden)o.push(ts[i]);}return o;}
function idxOf(l,id){for(var i=0;i<l.length;i++){if(l[i].id===id)return i;}return -1;}
function centered(d){var l=stageList(d),i=idxOf(l,d&&d.centeredId);return i<0?null:l[i];}
// What the compose bar and mic are aimed at: Kane while his pill is lit, else the focused
// session. The name rides along because sendToId drops a message whose name does not match the
// tile it finds — ids are workspace-scoped, and mirroring makes a stale list likelier.
function target(){
  if(!LAST)return null;
  if(TARGET==='kane'&&LAST.kane)return {id:KANE,name:LAST.kane.name};
  var c=centered(LAST);return c?{id:c.id,name:c.name}:null;
}
function ws(id){
  if(LAST&&LAST.workspaces){for(var i=0;i<LAST.workspaces.length;i++){LAST.workspaces[i].active=LAST.workspaces[i].id===id;}render(LAST);}
  post({type:'workspace',id:id});
}
// Optimistic: repaint with the new focus immediately so a swipe feels instant. Its output is
// blank until the next poll, because the desktop only sends a tail for the focused session.
function focusTile(id){TARGET='focus';if(LAST){LAST.centeredId=id;render(LAST);}post({type:'center',id:id});}
function kane(){TARGET=TARGET==='kane'?'focus':'kane';if(LAST)render(LAST);}
function step(dir){
  if(!LAST)return;
  var l=stageList(LAST);
  if(l.length<2)return;
  var i=idxOf(l,LAST.centeredId);if(i<0)i=0;
  focusTile(l[(i+dir+l.length)%l.length].id);
}
function send(){
  var t=target();if(!t){err('nothing focused');return;}
  var f=document.getElementById('f'),v=(f.value||'').trim();if(!v)return;
  post({type:'input',id:t.id,text:v,name:t.name}).then(function(r){
    if(!r.ok){err('send failed ('+r.status+')');return;}
    f.value='';err('sent to '+t.name);
  }).catch(function(){err('send failed — offline?');});
}
// Why the mic can't run, in the user's terms. NEVER hide the button silently: an absent control
// is indistinguishable from a broken one, and the two causes need different fixes.
function micWhy(){
  if(!SRC)return 'this browser has no speech API — use the mic on your keyboard instead';
  if(!window.isSecureContext)return 'mic needs the https:// link (tailscale serve) — you are on http://';
  return '';
}
function micDown(){
  if(!CAN_MIC)return;
  if(rec){try{rec.stop();}catch(_e){}rec=null;}
  var f=document.getElementById('f'),base=f.value?f.value+' ':'';
  err('');
  rec=new SRC();rec.lang='en-US';rec.interimResults=true;rec.continuous=false;
  rec.onresult=function(e){var s='';for(var i=0;i<e.results.length;i++){s+=e.results[i][0].transcript;}f.value=base+s;};
  rec.onerror=function(e){err(e.error==='not-allowed'?'mic permission denied':e.error==='no-speech'?'didn\\'t catch that':e.error);};
  try{rec.start();document.getElementById('mic').className='rec';}catch(_e){}
}
function micUp(){if(rec){try{rec.stop();}catch(_e){}rec=null;}document.getElementById('mic').className='';}
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
// The stage's children are built ONCE per focused session and then only their text is touched.
// Rebuilding innerHTML every poll destroyed and recreated the <pre>, which reset scrollTop to 0
// — that is what yanked you back to the top of the output every two seconds. Text is written
// with textContent, so nothing here needs escaping either.
var SKEY=null;
function setStage(key,name,meta,out){
  var st=document.getElementById('stage');
  if(SKEY!==key){
    SKEY=key;
    st.innerHTML=key==='none'
      ?'<div class="empty">nothing focused — tap a session below</div>'
      :'<div class="sname" id="sname"></div><div class="smeta" id="smeta"></div><pre id="sout"></pre>';
  }
  if(key==='none')return;
  var n=document.getElementById('sname'),m=document.getElementById('smeta'),p=document.getElementById('sout');
  if(n.textContent!==name)n.textContent=name;
  if(m.textContent!==meta)m.textContent=meta;
  if(p.textContent!==out){
    // Writing new text resets the scroll. Keep the reader where they were — and keep them
    // pinned to the newest line if that is where they already were.
    var atBottom=(p.scrollHeight-p.scrollTop-p.clientHeight)<24,prev=p.scrollTop;
    p.textContent=out;
    p.scrollTop=atBottom?p.scrollHeight:prev;
  }
}

var COORD=false;
function coord(){
  COORD=!COORD;
  document.getElementById('coord').className=COORD?'open':'';
  document.getElementById('others').style.display=COORD?'none':'';
  if(LAST)render(LAST);
}
// Rewrites the header, the stage, the satellite list and the coordination panel. #mic, #f,
// #send and the spawn controls are deliberately OUTSIDE all of them, so a poll can never wipe
// what you are typing or detach a listener mid-gesture.
function render(d){
  if(!repoFilled&&(d.repos||[]).length){document.getElementById('repo').innerHTML=d.repos.map(function(r){return '<option>'+esc(r)+'</option>';}).join('');repoFilled=true;}
  document.getElementById('ws').innerHTML=(d.workspaces||[]).map(function(w){
    return '<button class="ws'+(w.active?' on':'')+'" onclick="ws(\\''+esc(w.id)+'\\')">'+esc(w.name)+'</button>';
  }).join('');
  var kb=document.getElementById('kanebtn');
  kb.style.display=d.kane?'':'none';
  kb.className='pill'+(TARGET==='kane'?' on':'');
  var l=stageList(d),c=null,i=idxOf(l,d.centeredId);
  if(i>=0)c=l[i];
  if(TARGET==='kane'&&d.kane)setStage('k','Kane','overseer · talking to him',d.kane.output||'');
  else if(c)setStage('t'+c.id,c.name,c.repo+' · '+c.branch,c.output||'');
  else setStage('none','','','');
  // EVERY other on-stage session, not just the neighbours: ten of them look like three, the
  // list just scrolls. This is the desk's centred tile plus its satellites, shrunk.
  document.getElementById('others').innerHTML=l.filter(function(t){return t.id!==d.centeredId;}).map(function(t){
    return '<button class="oth" onclick="focusTile('+t.id+')"><span class="dot d-'+esc(t.state)+'"></span><span class="on">'+esc(t.name)+'</span></button>';
  }).join('')||'<div class="empty">no other sessions on stage</div>';
  var hid=[],ts=(d.terminals||[]);
  for(var k=0;k<ts.length;k++){if(ts[k].hidden)hid.push(ts[k]);}
  var cb=document.getElementById('coordbtn');
  cb.style.display=hid.length?'':'none';
  cb.className='pill'+(COORD?' on':'');
  cb.textContent='coord '+hid.length;
  document.getElementById('coord').innerHTML=hid.length
    ?'<div class="chead">hidden · tap to bring back on stage</div>'+hid.map(function(t){return '<button class="hchip" onclick="focusTile('+t.id+')">'+esc(t.name)+'</button>';}).join('')
    :'<div class="empty">nothing hidden</div>';
}
document.getElementById('send').addEventListener('click',send);
document.getElementById('spbtn').addEventListener('click',toggleSpawn);
document.getElementById('spgo').addEventListener('click',spawn);
document.getElementById('kanebtn').addEventListener('click',kane);
document.getElementById('coordbtn').addEventListener('click',coord);
var mb=document.getElementById('mic');
if(!CAN_MIC){
  mb.className='off';
  mb.addEventListener('click',function(){err(micWhy());});
  document.getElementById('f').placeholder='type — or hold your keyboard mic';
}else{mb.addEventListener('pointerdown',micDown);mb.addEventListener('pointerup',micUp);mb.addEventListener('pointercancel',micUp);}
// Swipe the strip to move the spotlight, mirroring Alt+←/→ at the desk. Must be decisive and
// clearly horizontal so scrolling the output pane never switches sessions by accident.
var sx=null,sy=null,strip=document.getElementById('strip');
strip.addEventListener('touchstart',function(e){
  if(e.touches.length!==1){sx=null;return;}
  sx=e.touches[0].clientX;sy=e.touches[0].clientY;
},{passive:true});
strip.addEventListener('touchend',function(e){
  if(sx===null)return;
  var t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;
  sx=null;
  if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.5)return;
  step(dx<0?1:-1);
},{passive:true});
function poll(){fetch('/api/floor?t='+T).then(function(r){return r.json();}).then(function(d){LAST=d;render(d);}).catch(function(){err('disconnected');});}
poll();setInterval(poll,2000);
</script></body></html>`;
