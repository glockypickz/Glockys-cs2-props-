// Push notifications in the app: "Turn on notifications" banner + Alerts settings (New lines / New grades).
// Hidden unless the Worker says notifications are set up and you are logged in (so the GitHub Pages copy shows nothing).
(function(){
var CFG=null,REG=null,SUB=null;
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function post(u,d){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d||{})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j._ok=r.ok;return j})})}
function ios(){var u=navigator.userAgent||'';return /iPad|iPhone|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1)}
function standalone(){return navigator.standalone===true||(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)}
function supported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window}
function keyBytes(b){var s=b.replace(/-/g,'+').replace(/_/g,'/');s+='==='.slice((s.length+3)%4);var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a}
function dismissed(){try{return +localStorage.getItem('gp_push_dismiss')>Date.now()}catch(e){return false}}
function toast(t){var x=document.getElementById('toast');if(!x){alert(t);return}x.textContent=t;x.classList.remove('hide');clearTimeout(toast._t);toast._t=setTimeout(function(){x.classList.add('hide')},3500)}

function turnOn(prefs){ // must run inside a tap
 if(!supported()){toast(ios()&&!standalone()?'Add the site to your Home Screen first, then turn on notifications there.':'This browser can\'t do notifications.');return Promise.resolve(false)}
 return Notification.requestPermission().then(function(p){
  if(p!=='granted'){toast('Notifications are blocked. Allow them for this site in your settings.');return false}
  return (REG?Promise.resolve(REG):navigator.serviceWorker.register('/sw.js')).then(function(reg){REG=reg;return navigator.serviceWorker.ready}).then(function(reg){
   return reg.pushManager.getSubscription().then(function(s){return s||reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(CFG.publicKey)})})
  }).then(function(s){SUB=s;return post('/push/subscribe',{subscription:s.toJSON(),prefs:prefs||CFG.prefs})}).then(function(d){
   if(!d._ok){toast(d.error||'Could not turn on notifications.');return false}
   CFG.prefs=d.prefs;try{localStorage.setItem('gp_push_sync',Date.now())}catch(e){}
   toast('Notifications are on 🔔');hideBanner();return true})
 }).catch(function(e){toast('Could not turn on notifications. Try again.');return false})}
function turnOff(){if(!SUB)return Promise.resolve();var ep=SUB.endpoint;return SUB.unsubscribe().catch(function(){}).then(function(){SUB=null;return post('/push/unsubscribe',{endpoint:ep})}).then(function(){toast('Notifications are off on this device.')})}

var banner=null;
function hideBanner(){if(banner){banner.remove();banner=null}}
function showBanner(){
 if(SUB||dismissed()||banner)return;
 var iosHint=ios()&&!standalone();
 if(!iosHint&&(!supported()||Notification.permission==='denied'))return;
 banner=el('div','gp-push');var t=el('div','gp-push-t');
 if(iosHint){t.appendChild(el('b',null,'🔔 Get alerts on your iPhone'));t.appendChild(el('span',null,'Tap Share ⬆️ then "Add to Home Screen", open GP Grader from your Home Screen, and turn on notifications there.'))}
 else{t.appendChild(el('b',null,'🔔 Get notified'));t.appendChild(el('span',null,'When new lines go up and new grades are posted.'))}
 banner.appendChild(t);var bs=el('div','gp-push-b');
 if(!iosHint){var on=el('button','gp-on','Turn on notifications');on.type='button';on.onclick=function(){on.disabled=true;turnOn().then(function(){on.disabled=false})};bs.appendChild(on)}
 var no=el('button','gp-no',iosHint?'Got it':'Not now');no.type='button';no.onclick=function(){try{localStorage.setItem('gp_push_dismiss',Date.now()+7*864e5)}catch(e){};hideBanner()};bs.appendChild(no);
 banner.appendChild(bs);
 var h=document.querySelector('header');if(h&&h.parentNode)h.parentNode.insertBefore(banner,h.nextSibling);else document.body.insertBefore(banner,document.body.firstChild)}

function openSettings(){
 var bg=el('div','gp-sheet-bg'),s=el('div','gp-sheet');bg.appendChild(s);
 function close(){bg.remove()}
 bg.onclick=function(e){if(e.target===bg)close()};
 var hd=el('div','gp-sheet-h');hd.appendChild(el('b',null,'🔔 Notifications'));var x=el('button','gp-x','✕');x.type='button';x.onclick=close;hd.appendChild(x);s.appendChild(hd);
 var st=el('div','gp-sheet-st');s.appendChild(st);
 function row(key,label,sub){var r=el('label','gp-tg');var c=document.createElement('input');c.type='checkbox';c.checked=CFG.prefs[key]!==false;
  c.onchange=function(){var p={lines:CFG.prefs.lines,grades:CFG.prefs.grades};p[key]=c.checked;post('/push/prefs',p).then(function(d){if(d._ok)CFG.prefs=d.prefs})};
  var tx=el('span');tx.appendChild(el('b',null,label));tx.appendChild(el('small',null,sub));r.appendChild(tx);r.appendChild(c);r.appendChild(el('i'));return r}
 s.appendChild(row('lines','New lines','When new props go up on the board'));
 s.appendChild(row('grades','New grades','When new grades are posted'));
 var btn=el('button','gp-on');btn.type='button';s.appendChild(btn);
 function draw(){
  if(ios()&&!standalone()){st.textContent='On iPhone: tap Share ⬆️ → "Add to Home Screen", then open GP Grader from your Home Screen to turn notifications on.';btn.classList.add('hide');return}
  if(!supported()){st.textContent='This browser can\'t do notifications.';btn.classList.add('hide');return}
  if(Notification.permission==='denied'){st.textContent='Notifications are blocked for this site. Allow them in your browser or phone settings.';btn.classList.add('hide');return}
  st.textContent=SUB?'On for this device.':'Off on this device.';btn.textContent=SUB?'Turn off on this device':'Turn on notifications';btn.classList.remove('hide')}
 btn.onclick=function(){btn.disabled=true;(SUB?turnOff():turnOn()).then(function(){btn.disabled=false;draw()})};
 draw();document.body.appendChild(bg)}

function addButton(tries){var bar=document.querySelector('.gp-acct');if(!bar){if(tries<40)setTimeout(function(){addButton(tries+1)},250);return}
 if(bar.querySelector('.gp-bell'))return;var b=el('button','gp-bell','🔔 Alerts');b.type='button';b.onclick=openSettings;bar.insertBefore(b,bar.children[1]||null)}

fetch('/push/config',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
 if(!d||!d.enabled||!d.user)return;CFG=d;CFG.prefs=CFG.prefs||{lines:true,grades:true};
 window.GPPush={open:openSettings};addButton(0);
 if(!supported()){showBanner();return}
 navigator.serviceWorker.register('/sw.js').then(function(reg){REG=reg;return reg.pushManager.getSubscription()}).then(function(s){
  SUB=s;
  if(s){var last=0;try{last=+localStorage.getItem('gp_push_sync')||0}catch(e){}
   if(Date.now()-last>864e5)post('/push/subscribe',{subscription:s.toJSON()}).then(function(){try{localStorage.setItem('gp_push_sync',Date.now())}catch(e){}})}
  showBanner()}).catch(function(){showBanner()});
}).catch(function(){});
})();
