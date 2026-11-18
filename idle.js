// Idle sign-out: after 30 minutes with no taps, typing, scrolling or mouse movement, sign out and go to the login page.
// The server enforces the same window (beta_auth.js): only real activity (page loads + the ping below) keeps a session
// alive, so background polling never does. Admin-key holders (no account) and the GitHub Pages copy are not affected.
(function(){
var IDLE=30*60000,K='gp_last_act',PING_EVERY=120000,lastPing=Date.now(),lastWrite=0,warned=false,out=false;
function now(){return Date.now()}
function last(){try{return +localStorage.getItem(K)||0}catch(e){return 0}}
function setLast(t){try{localStorage.setItem(K,String(t))}catch(e){}}
function toast(t){var x=document.getElementById('toast');if(!x)return;x.textContent=t;x.classList.remove('hide');clearTimeout(toast._t);toast._t=setTimeout(function(){x.classList.add('hide')},8000)}
function signOut(){if(out)return;out=true;
 var go=function(){location.href='/login?idle=1&next='+encodeURIComponent(location.pathname+location.search)};
 fetch('/auth/logout',{method:'POST'}).then(go,go)}
function ping(){lastPing=now();fetch('/auth/ping',{method:'POST'}).then(function(r){if(r.status===401)signOut()}).catch(function(){})}
function check(){if(out)return;var idle=now()-last();
 if(idle>=IDLE){signOut();return}
 if(idle>=IDLE-120000&&!warned){warned=true;toast('Still there? You\'ll be signed out in 2 minutes. Tap anywhere to stay signed in.')}}
function act(){if(out)return;var t=now();
 if(t-last()>=IDLE){signOut();return}            // came back after the window: too late
 if(t-lastWrite>5000){lastWrite=t;setLast(t)}
 warned=false;
 if(t-lastPing>PING_EVERY)ping()}
function start(min){IDLE=(min||30)*60000;setLast(now());
 ['pointerdown','keydown','touchstart','wheel','mousemove','input'].forEach(function(e){document.addEventListener(e,act,{passive:true,capture:true})});
 window.addEventListener('scroll',act,{passive:true,capture:true});
 document.addEventListener('visibilitychange',function(){if(!document.hidden)check()});
 window.addEventListener('focus',check);window.addEventListener('pageshow',check);
 setInterval(check,15000);
 window.GPIdle={check:check,signOut:signOut}}
fetch('/auth/me',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
 if(d&&d.configured&&d.user)start(d.idleMin)}).catch(function(){});
})();
