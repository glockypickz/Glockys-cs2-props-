(function(){
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function key(){try{return localStorage.getItem('gp_admin')||''}catch(e){return ''}}
(function(){try{var m=/admin=([^&]*)/.exec(location.hash||'');if(m){localStorage.setItem('gp_admin',decodeURIComponent(m[1]));history.replaceState(null,'',location.pathname)}}catch(e){}})();
function msg(t,ok){var m=$('msg');m.textContent=t||'';m.className='msg '+(ok?'ok':'err')}
function hdr(){var h={'Content-Type':'application/json'};if(key())h['X-Admin-Key']=key();return h}
function api(path,data){return fetch('/auth/admin/'+path,{method:data?'POST':'GET',headers:hdr(),body:data?JSON.stringify(data):undefined,cache:'no-store'})
 .then(function(r){return r.json().catch(function(){return{}}).then(function(d){d._s=r.status;return d})})}
function day(s){return s?new Date(s).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'never'}
var S=null;
// Works with a logged-in admin account (cookie) or the admin key saved on this device.
function load(){
 api('state').then(function(d){
  if(d._s===403){try{localStorage.removeItem('gp_admin')}catch(e){};$('keyCard').classList.remove('hide');$('app').classList.add('hide');msg('');var k=$('k');k.value='';k.placeholder='That key did not work';return}
  $('keyCard').classList.add('hide');
  if(d._s===503){$('off').classList.remove('hide');$('offTxt').textContent=(d.error||'')+' Until then the site stays open to everyone, exactly as before.';return}
  S=d;$('app').classList.remove('hide');draw();
  if(key())fetch('/auth/admin/session',{method:'POST',headers:{'X-Admin-Key':key()}}).catch(function(){});
 }).catch(function(){msg('Could not reach the site.')})}
function draw(){var on=S.gate==='on';$('gateTxt').textContent=on?'ON':'OFF';$('gateTxt').className='big '+(on?'on':'off');
 $('gateNote').textContent=S.forced?'Locked '+S.forced.toUpperCase()+' by the BETA_GATE setting in Cloudflare.':(on?'Only logged-in beta users (and you) can open the Grader.':'Anyone can open the Grader, as before.');
 $('gateBtn').textContent=on?'Turn off':'Turn on';$('gateBtn').disabled=!!S.forced;
 $('invites').innerHTML=S.invites.length?S.invites.map(function(i){var st=i.revoked?'<span class="pill off">revoked</span>':(i.uses>=i.max?'<span class="pill">used up</span>':'<span class="pill on">active</span>');
  return '<div class="item"><div class="t"><b>'+esc(i.code)+'</b> '+st+'<div class="muted">'+esc(i.note||'')+(i.note?' · ':'')+i.uses+'/'+i.max+' used · '+day(i.created)+(i.users&&i.users.length?' · '+esc(i.users.join(', ')):'')+'</div></div>'+(i.revoked?'':'<button class="r" data-rev="'+esc(i.code)+'">Revoke</button>')+'</div>'}).join(''):'<div class="muted">No invite codes yet.</div>';
 $('users').innerHTML=S.users.length?S.users.map(function(u){return '<div class="item"><div class="t"><b>'+esc(u.u)+'</b> '+(u.role==='admin'?'<span class="pill on">ADMIN</span> ':'')+(u.disabled?'<span class="pill off">off</span>':'<span class="pill on">active</span>')+'<div class="muted">'+esc(u.email)+' · joined '+day(u.created)+' · last login '+day(u.last)+'</div></div>'
  +'<button class="g" data-role="'+esc(u.u)+'" data-a="'+(u.role==='admin'?0:1)+'">'+(u.role==='admin'?'Make customer':'Make admin')+'</button><button class="g" data-reset="'+esc(u.u)+'">Reset password</button><button class="'+(u.disabled?'g':'r')+'" data-dis="'+esc(u.u)+'" data-v="'+(u.disabled?0:1)+'">'+(u.disabled?'Turn on':'Turn off')+'</button></div>'}).join(''):'<div class="muted">No one has signed up yet.</div>'}
$('fKey').onsubmit=function(e){e.preventDefault();try{localStorage.setItem('gp_admin',$('k').value.trim())}catch(x){};load()};
$('gateBtn').onclick=function(){var on=S.gate!=='on';if(on&&!confirm('Turn the login gate ON? Customers will need an account to open the Grader.'))return;api('gate',{on:on}).then(function(d){if(d.ok){S.gate=d.gate;draw();msg('Gate is '+d.gate.toUpperCase()+'. '+(d.note||''),true)}else msg(d.error)})};
$('fInv').onsubmit=function(e){e.preventDefault();api('invite',{note:$('note').value,max:$('max').value}).then(function(d){if(!d.ok)return msg(d.error);
 var c=d.invite.code,l=location.origin+'/login?invite='+c;$('codeTxt').textContent=c;$('codeLink').textContent=l;$('codeLink').href=l;$('newCode').classList.remove('hide');S.invites.unshift(d.invite);draw();$('note').value='';msg('')})};
document.addEventListener('click',function(e){var t=e.target;
 if(t.dataset.rev){if(!confirm('Revoke invite '+t.dataset.rev+'? Accounts already made with it keep working.'))return;api('invite/revoke',{code:t.dataset.rev}).then(function(d){if(!d.ok)return msg(d.error);S.invites=S.invites.map(function(i){return i.code===d.invite.code?d.invite:i});draw()})}
 if(t.dataset.dis){var off=t.dataset.v==='1';if(off&&!confirm('Turn off '+t.dataset.dis+'? They are logged out right away.'))return;api('user/disable',{u:t.dataset.dis,disabled:off}).then(function(d){if(!d.ok)return msg(d.error);S.users.forEach(function(u){if(u.u===d.u)u.disabled=d.disabled});draw()})}
 if(t.dataset.role){var up=t.dataset.a==='1';if(!confirm(up?'Make '+t.dataset.role+' an admin? Admins see the full Track Record and these owner tools.':'Make '+t.dataset.role+' a normal customer? They lose the Track Record and owner tools.'))return;api('user/role',{u:t.dataset.role,admin:up}).then(function(d){if(!d.ok)return msg(d.error);S.users.forEach(function(u){if(u.u===d.u)u.role=d.role});draw();msg(d.u+' is now '+(d.role==='admin'?'an admin':'a customer')+'.',true)})}
 if(t.dataset.reset){if(!confirm('Reset the password for '+t.dataset.reset+'? They are logged out and get a temporary password from you.'))return;api('user/reset',{u:t.dataset.reset}).then(function(d){if(!d.ok)return msg(d.error);msg('Temporary password for '+d.u+': '+d.tempPassword+'  (shown once, send it to them privately)',true)})}
});
$('forget').onclick=function(){try{localStorage.removeItem('gp_admin')}catch(e){};fetch('/auth/logout',{method:'POST'}).then(function(){location.href='/login'})};
// ---- support inbox ----
var SUPU=null;
function supLoad(){api('support/threads').then(function(d){if(!d.threads)return;var n=d.unread||0;$('supUnread').textContent=n+' unread';$('supUnread').classList.toggle('hide',!n);
 var L=$('supList');L.innerHTML='';if(!d.threads.length){L.appendChild(Object.assign(document.createElement('div'),{className:'muted',textContent:'No messages yet.'}));return}
 d.threads.forEach(function(t){var it=document.createElement('div');it.className='item click';var tx=document.createElement('div');tx.className='t';var b=document.createElement('b');b.textContent=t.u;tx.appendChild(b);
  if(t.unread){var un=document.createElement('span');un.className='un';un.textContent=t.unread;tx.appendChild(document.createTextNode(' '));tx.appendChild(un)}
  var m=document.createElement('div');m.className='muted';m.textContent=(t.last.f==='o'?'You: ':'')+t.last.t+' · '+day(t.updated);tx.appendChild(m);it.appendChild(tx);it.onclick=function(){supOpen(t.u)};L.appendChild(it)})})}
function supDraw(msgs){var M=$('supMsgs');M.innerHTML='';msgs.forEach(function(m){var d=document.createElement('div');d.className='m '+(m.f==='o'?'o':'u');d.textContent=m.t;var a=document.createElement('div');a.className='at';a.textContent=(m.f==='o'?'You':SUPU)+' · '+day(m.at);d.appendChild(a);M.appendChild(d)});M.scrollTop=M.scrollHeight}
function supOpen(u){SUPU=u;$('supList').classList.add('hide');$('supThread').classList.remove('hide');$('supWho').textContent=u;api('support/thread?u='+encodeURIComponent(u)).then(function(d){if(d.msgs)supDraw(d.msgs);supLoad()})}
$('supBack').onclick=function(){SUPU=null;$('supThread').classList.add('hide');$('supList').classList.remove('hide');supLoad()};
$('fReply').onsubmit=function(e){e.preventDefault();var t=$('replyTxt').value.trim();if(!t)return;api('support/reply',{u:SUPU,text:t}).then(function(d){if(!d.ok)return msg(d.error);$('replyTxt').value='';supDraw(d.msgs)})};
// ---- notifications ----
function pushLoad(){api('push/status').then(function(d){if(d._s!==200)return;$('pushOff').classList.toggle('hide',d.ready);$('pushOn').classList.toggle('hide',!d.ready);
 if(d.ready)$('pushStat').textContent=d.subscriptions+' device'+(d.subscriptions===1?'':'s')+' signed up · last lines alert: '+day(d.last.lines)+' · last grades alert: '+day(d.last.grades)})}
function sendAll(data){var tot={sent:0,removed:0,failed:0,skipped:0};function step(extra){return api('notify',Object.assign({},data,extra)).then(function(d){if(!d.ok){msg(d.error);return null}if(d.skipped&&!d.job){msg('Skipped: '+d.skipped);return null}
 ['sent','removed','failed','skipped'].forEach(function(k){tot[k]+=d[k]||0});return d.cursor?step({job:d.job,cursor:d.cursor}):tot})}return step({})}
$('pushSetup').onclick=function(){api('push/setup',{}).then(function(d){if(!d.ok)return msg(d.error);msg('Notifications are set up.',true);pushLoad()})};
$('pushTest').onclick=function(){sendAll({type:'test',title:'Test notification',body:'Notifications are working 🔔',url:'/'}).then(function(t){if(t)msg('Test sent to '+t.sent+' admin device'+(t.sent===1?'':'s')+(t.sent?'':' (turn on 🔔 Alerts in the app first)')+'.',true)})};
$('fNotify').onsubmit=function(e){e.preventDefault();if(!confirm('Send this to everyone with notifications on?'))return;
 sendAll({type:'manual',title:$('nTitle').value,body:$('nBody').value,url:$('nUrl').value}).then(function(t){if(t){msg('Sent to '+t.sent+' device'+(t.sent===1?'':'s')+(t.removed?', removed '+t.removed+' dead':'')+'.',true);$('nBody').value='';pushLoad()}})};
var _draw=draw;draw=function(){_draw();if(!draw._once){draw._once=1;supLoad();pushLoad();var m=/support=([^&]+)/.exec(location.hash||'');if(m)supOpen(decodeURIComponent(m[1]));setInterval(function(){if(!SUPU)supLoad()},60000)}};
load();
})();
