(function(){
var $=function(i){return document.getElementById(i)};
var next=(function(){var n=new URLSearchParams(location.search).get('next')||'/';return n.charAt(0)==='/'&&n.charAt(1)!=='/'?n:'/'})();
function msg(t,ok){var m=$('msg');m.textContent=t||'';m.className='msg '+(ok?'ok':'err')}
function go(){location.replace(next)}
// Owner: the same  #admin=KEY  link as the app. Save it, swap it for a login cookie, then go in.
(function(){try{var m=/admin=([^&]*)/.exec(location.hash||'');if(m){var k=decodeURIComponent(m[1]);if(k==='off')localStorage.removeItem('gp_admin');else localStorage.setItem('gp_admin',k);history.replaceState(null,'',location.pathname+location.search)}}catch(e){}})();
var key='';try{key=localStorage.getItem('gp_admin')||''}catch(e){}
if(key){fetch('/auth/admin/session',{method:'POST',headers:{'X-Admin-Key':key}}).then(function(r){if(r.ok)go()}).catch(function(){})}
if(new URLSearchParams(location.search).get('idle')==='1')msg('You were signed out after 30 minutes without activity. Log in again.',true);
fetch('/auth/me',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
 if(d.user||d.admin||d.gate!=='on')go();
 if(!d.configured)msg('Beta login is not switched on yet, the site is open.',true);
}).catch(function(){});
function tab(sign){$('tLogin').className=sign?'':'on';$('tSign').className=sign?'on':'';$('fLogin').classList.toggle('hide',sign);$('fSign').classList.toggle('hide',!sign);msg('')}
$('tLogin').onclick=function(){tab(false)};$('tSign').onclick=function(){tab(true)};
if(new URLSearchParams(location.search).get('invite')){tab(true);$('si').value=new URLSearchParams(location.search).get('invite')}
function post(url,data,form){var b=form.querySelector('button');b.disabled=true;msg('');
 fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
 .then(function(r){return r.json().catch(function(){return{}}).then(function(d){return{ok:r.ok,d:d}})})
 .then(function(x){if(x.ok){msg('You\'re in. Loading the Grader...',true);setTimeout(go,300)}else{msg(x.d.error||'Something went wrong. Try again.');b.disabled=false}})
 .catch(function(){msg('Could not reach the site. Check your connection.');b.disabled=false})}
$('fLogin').onsubmit=function(e){e.preventDefault();post('/auth/login',{username:$('lu').value,password:$('lp').value,next:next},this)};
$('fSign').onsubmit=function(e){e.preventDefault();post('/auth/signup',{invite:$('si').value,username:$('su').value,email:$('se').value,password:$('sp').value,next:next},this)};
})();
