/* Welcome screen: shows every time the site is opened or reloaded. Tap ENTER to open the app. No sound. */
(function(){
  function init(){
    var d=document.createElement('div');d.id='enter';
    d.innerHTML='<div class="box"><div class="t">GLOCKYS PROP GRADER</div><button type="button">ENTER</button><div class="s">Tap to enter</div></div>';
    document.body.appendChild(d);
    d.querySelector('button').onclick=function(){d.classList.add('out');setTimeout(function(){d.remove()},500)};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
