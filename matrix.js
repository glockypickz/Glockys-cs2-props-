/* Matrix-style falling code behind the app. Dim so text stays readable; stops for reduced-motion and hidden tabs. */
(function(){
  var cv=document.getElementById('rain');if(!cv||!cv.getContext)return;
  var cx=cv.getContext('2d'),W=0,H=0,FS=16,cols=0,drops=[],speed=[],timer=null;
  var CH='ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFXYZ';
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  function size(){
    var d=Math.min(window.devicePixelRatio||1,2);
    W=window.innerWidth;H=window.innerHeight;
    cv.width=W*d;cv.height=H*d;cv.style.width=W+'px';cv.style.height=H+'px';
    cx.setTransform(d,0,0,d,0,0);
    cols=Math.ceil(W/FS);drops=[];speed=[];
    for(var i=0;i<cols;i++){drops.push(Math.floor(Math.random()*-H/FS));speed.push(.35+Math.random()*.65)}
    cx.fillStyle='#030705';cx.fillRect(0,0,W,H);
  }
  function frame(){
    cx.fillStyle='rgba(3,7,5,.09)';cx.fillRect(0,0,W,H);
    cx.font=FS+'px monospace';
    for(var i=0;i<cols;i++){
      var y=drops[i]*FS;
      if(y>0){
        cx.fillStyle='rgba(190,255,215,.85)';
        cx.fillText(CH.charAt(Math.floor(Math.random()*CH.length)),i*FS,y);
        cx.fillStyle='rgba(0,255,102,.55)';
        cx.fillText(CH.charAt(Math.floor(Math.random()*CH.length)),i*FS,y-FS);
      }
      drops[i]+=speed[i];
      if(y>H&&Math.random()>.975)drops[i]=Math.floor(Math.random()*-20);
    }
  }
  function start(){if(!timer&&!reduce)timer=setInterval(frame,55)}
  function stop(){if(timer){clearInterval(timer);timer=null}}
  size();
  if(reduce){for(var k=0;k<90;k++)frame()}else start();
  var rt;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){size();if(reduce)for(var k=0;k<90;k++)frame()},200)});
  document.addEventListener('visibilitychange',function(){document.hidden?stop():start()});
})();
