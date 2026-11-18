// Beta login: shows "Signed in as ... · Log out" under the header when the Worker's login gate is in use.
// On the GitHub Pages copy (no Worker) /auth/me doesn't exist, so nothing is shown.
(function(){
fetch('/auth/me',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
 if(!d||!(d.user||d.admin))return;
 var bar=document.createElement('div');bar.className='gp-acct';
 var who=document.createElement('span');who.textContent=d.user?'Signed in as '+d.user+(d.admin?' (admin)':''):'Signed in as owner';
 var b=document.createElement('button');b.type='button';b.textContent='Log out';
 b.onclick=function(){try{if(!d.user)localStorage.removeItem('gp_admin')}catch(e){}
  fetch('/auth/logout',{method:'POST'}).then(function(){location.href='/login'},function(){location.href='/login'})};
 bar.appendChild(who);bar.appendChild(b);
 if(d.admin){var a=document.createElement('a');a.href='/beta-admin';a.textContent='Beta admin';bar.appendChild(a)}
 var h=document.querySelector('header');if(h)h.appendChild(bar);
}).catch(function(){});
})();
