// Support chat bubble (bottom-left): logged-in beta users message @GlockyPickz and see replies in one thread.
// Messages are always shown with textContent (plain text, never HTML).
(function(){
var ME=null,OPEN=false,PANEL=null,BADGE=null,BTN=null,LIST=null,TIMER=null,MSGS=[];
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function post(u,d){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d||{})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j._ok=r.ok;return j})})}
function when(s){var d=new Date(s);return isNaN(d)?'':d.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function badge(n){if(!BADGE)return;BADGE.textContent=n>9?'9+':String(n);BADGE.classList.toggle('hide',!n)}
function draw(){if(!LIST)return;LIST.innerHTML='';
 if(!MSGS.length){LIST.appendChild(el('div','gp-sup-empty','Questions about a pick, your account or the beta? Send a message and @GlockyPickz will reply here.'));return}
 MSGS.forEach(function(m){var b=el('div','gp-msg '+(m.f==='u'?'me':'them'));b.appendChild(el('div','gp-msg-t',m.t));b.appendChild(el('div','gp-msg-at',(m.f==='u'?'You':'GlockyPickz')+' · '+when(m.at)));LIST.appendChild(b)});
 LIST.scrollTop=LIST.scrollHeight}
function load(){return fetch('/support/thread',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;MSGS=d.msgs||[];draw();if(OPEN&&d.unread)post('/support/read').then(function(){badge(0)});else badge(d.unread||0)})}
function peek(){if(OPEN)return load();fetch('/support/thread?peek=1',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d)badge(d.unread||0)}).catch(function(){})}
function toggle(){OPEN=!OPEN;PANEL.classList.toggle('hide',!OPEN);if(OPEN){load();setTimeout(function(){PANEL.querySelector('textarea').focus()},50)}}
function build(){
 BTN=el('button','gp-sup-btn');BTN.type='button';BTN.setAttribute('aria-label','Message @GlockyPickz');BTN.appendChild(el('span',null,'💬'));BTN.appendChild(el('span','gp-sup-l','Support'));BADGE=el('span','gp-sup-badge hide','0');BTN.appendChild(BADGE);BTN.onclick=toggle;
 PANEL=el('div','gp-sup hide');var h=el('div','gp-sup-h');var tt=el('div');tt.appendChild(el('b',null,'Message @GlockyPickz'));tt.appendChild(el('small',null,'Beta support · replies show up here'));h.appendChild(tt);
 var x=el('button','gp-x','✕');x.type='button';x.onclick=toggle;h.appendChild(x);PANEL.appendChild(h);
 LIST=el('div','gp-sup-list');PANEL.appendChild(LIST);
 var f=el('form','gp-sup-f');var ta=document.createElement('textarea');ta.maxLength=1000;ta.rows=2;ta.placeholder='Type a message...';var cnt=el('div','gp-sup-cnt','');var sb=el('button','gp-on','Send');sb.type='submit';
 ta.oninput=function(){cnt.textContent=ta.value.length>800?(1000-ta.value.length)+' left':''};
 ta.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey&&!('ontouchstart' in window)){e.preventDefault();f.requestSubmit?f.requestSubmit():f.onsubmit(e)}};
 var err=el('div','gp-sup-err');
 f.onsubmit=function(e){e.preventDefault();var t=ta.value.trim();if(!t)return;sb.disabled=true;err.textContent='';
  post('/support/send',{text:t}).then(function(d){sb.disabled=false;if(!d._ok){err.textContent=d.error||'Could not send. Try again.';return}ta.value='';cnt.textContent='';MSGS=d.msgs||MSGS;draw()}).catch(function(){sb.disabled=false;err.textContent='Could not send. Check your connection.'})};
 f.appendChild(ta);f.appendChild(sb);PANEL.appendChild(f);PANEL.appendChild(cnt);PANEL.appendChild(err);
 document.body.appendChild(BTN);document.body.appendChild(PANEL)}
fetch('/auth/me',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
 if(!d||!d.user||!d.configured)return;ME=d.user;build();peek();TIMER=setInterval(peek,60000);
 if(/(^|#)support/.test(location.hash||''))toggle();
 if(navigator.serviceWorker)navigator.serviceWorker.addEventListener('message',function(e){if(e.data&&e.data.gpPush&&/^support/.test(e.data.gpPush.tag||''))peek()});
 document.addEventListener('visibilitychange',function(){if(!document.hidden)peek()});
}).catch(function(){});
})();
