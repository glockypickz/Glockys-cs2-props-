// Trading-card view of one graded prop (Grader tab) and its image export. Display only: it reads the grade object the
// app already built (gradeFor in app.js) and never changes a projection, letter, pick or lock.
// Team logos: team_logos.json (bo3.gg team image_url, refreshed by team_logos.py); monogram badge when there is none.
(function(){
'use strict';
var FONT='"Russo One",Impact,"Arial Black",sans-serif';
// Foil per letter. A+ = holo gold, B = silver, C = bronze, D = gunmetal, F = crimson holo (F is the strong Under play).
var TIERS={
 'A+':{name:'HOLO GOLD',foil:['#fff3b0','#ffd34d','#ff9ad5','#8ef7ff','#b6ff7a','#ffd34d','#fff3b0'],accent:'#ffd34d',ink:'#1a1200'},
 'A':{name:'GOLD',foil:['#fff3b0','#ffd34d','#b8860b','#ffe680','#ffd34d'],accent:'#ffd34d',ink:'#1a1200'},
 'B':{name:'SILVER',foil:['#f7f9fb','#9aa3ab','#e9edf0','#6f7880','#f7f9fb'],accent:'#e6eaee',ink:'#111'},
 'C':{name:'BRONZE',foil:['#ffd9a8','#b5692c','#f3c08a','#7a4318','#ffd9a8'],accent:'#ffb45e',ink:'#1a0d00'},
 'D':{name:'GUNMETAL',foil:['#8a9099','#2b2e33','#a9b0b9','#3a3e44','#8a9099'],accent:'#ff8095',ink:'#fff'},
 'F':{name:'CRIMSON HOLO',foil:['#ff9aa9','#ff2d55','#7a0019','#ff6b81','#b0002a','#ff9aa9'],accent:'#ff4d6d',ink:'#fff'}};
function tier(gr){return TIERS[gr]||TIERS.D}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function sname(s){return s==='hs'?'Headshots':'Kills'}
function key(s){return window.GPModel&&GPModel.tn?GPModel.tn(s):String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function mono(t){var w=String(t||'?').replace(/[^A-Za-z0-9 ]/g,' ').trim().split(/\s+/).filter(Boolean);if(!w.length)return '?';return (w.length>1?w[0][0]+w[1][0]:w[0].slice(0,3)).toUpperCase()}
function pct(x){return x==null||isNaN(x)?'–':Math.round(x*100)+'%'}
function edge(g){return g.edgePP==null||isNaN(g.edgePP)?'–':(g.edgePP>=0?'+':'')+g.edgePP.toFixed(1)+'pp'}
function l10(g){var h=g.hits&&g.hits.l10;return h&&h[1]?h[0]+'/'+h[1]:'–'}
// Season player stats from the same Maps 1-2 series the grade uses (g.cs, newest first).
// HS% = headshots / kills; K/D = kills / deaths; Kills Map 1 = average Map 1 kills (kills1 on a Maps 1-2 series; on a Map 1 prop every series is one Map 1, so its kills);
// HS / MAP = season average of (Map 1 HS + Map 2 HS) / 2 per series; Kills/HS 1-2 L10 = average total Maps 1-2 kills/headshots over the last 10 series.
function isM1(g){var p=g&&g.period;return window.GPMap1&&GPMap1.isMap1?GPMap1.isMap1({period:p}):p==='Map 1'}
function pstats(g){var m1=isM1(g),cs=g.cs||[],k=0,n=0,hk=0,hh=0,nh=0,dk=0,dd=0,k1=0,n1=0;cs.forEach(function(c){if(c.kills==null)return;k+=c.kills;n++;if(c.hs!=null){hh+=c.hs;hk+=c.kills;nh++}if(c.deaths!=null){dk+=c.kills;dd+=c.deaths}if(c.kills1!=null){k1+=c.kills1;n1++}else if(m1){k1+=c.kills;n1++}});
 var l10=cs.slice(0,10),h10=0,n10=0,k10=0,nk10=0;l10.forEach(function(c){if(c.hs!=null){h10+=c.hs;n10++}if(c.kills!=null){k10+=c.kills;nk10++}});
 return {n:n,hsp:hk?Math.round(hh/hk*100)+'%':'–',kd:dd?(dk/dd).toFixed(2):'–',k1:n1?(k1/n1).toFixed(1):'–',hpm:nh?(hh/(2*nh)).toFixed(1):'–',kl10:nk10?(k10/nk10).toFixed(1):'–',hsl10:n10?(h10/n10).toFixed(1):'–'}}
function vals(g){return (g.cs||[]).slice(0,10).map(function(c){return c[g.stat]}).filter(function(x){return x!=null}).reverse()}

// ---- logos
var LOGOS=null,waiting=[];
function logoUrl(team){if(!LOGOS||!team)return null;return LOGOS[key(team)]||null}
function loadLogos(){try{fetch('team_logos.json',{cache:'no-cache'}).then(function(r){return r.ok?r.json():{}}).then(function(d){var m={},l=(d&&d.logos)||{};Object.keys(l).forEach(function(k){var u=l[k];if(typeof u==='string'&&u.indexOf('https://files.bo3.gg/')===0)m[key(k)]=u});LOGOS=m;patch();waiting.splice(0).forEach(function(f){f()})}).catch(function(){LOGOS={};waiting.splice(0).forEach(function(f){f()})})}catch(e){LOGOS={}}}
function whenLogos(cb){if(LOGOS)cb();else{waiting.push(cb);setTimeout(function(){var i=waiting.indexOf(cb);if(i>=0){waiting.splice(i,1);cb()}},2500)}}
function badge(team){var u=logoUrl(team);return u?'<img src="'+esc(u)+'" alt="'+esc(team)+'" crossorigin="anonymous" loading="lazy" onerror="this.parentNode.classList.add(\'mono\');this.remove()">':''}
function patch(){var els=document.querySelectorAll('.tc-logo[data-team]');for(var i=0;i<els.length;i++){var e=els[i];if(e.querySelector('img'))continue;var b=badge(e.getAttribute('data-team'));if(b){e.classList.remove('mono');e.insertAdjacentHTML('afterbegin',b)}}}
// Player photos: player_photos.json + same-origin files in assets/players/ (cached from the lines feed so the export is not blocked by CORS).
var PHOTOS=null,photowait=[];
function pkey(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function photoSrc(player){if(!PHOTOS||!player)return null;var p=PHOTOS[pkey(player)];return (p&&typeof p.file==='string'&&p.file.indexOf('assets/players/')===0)?p.file:null}
function photosReady(list){PHOTOS=list;photowait.splice(0).forEach(function(f){f()});try{document.dispatchEvent(new Event('gp-photos'))}catch(e){}}
function loadPhotos(){try{fetch('player_photos.json',{cache:'no-cache'}).then(function(r){return r.ok?r.json():{}}).then(function(d){var m={},l=(d&&d.photos)||{};Object.keys(l).forEach(function(k){var f=l[k]&&l[k].file;if(typeof f==='string'&&f.indexOf('assets/players/')===0)m[k]=l[k]});photosReady(m)}).catch(function(){photosReady({})})}catch(e){photosReady({})}}
function whenPhotos(cb){if(PHOTOS)cb();else{photowait.push(cb);setTimeout(function(){var i=photowait.indexOf(cb);if(i>=0){photowait.splice(i,1);cb()}},2500)}}
function hasPic(player){return !!photoSrc(player)}
// If a cached file 404s, drop the portrait window and keep the compact no-photo layout (no silhouette).
function dropPic(el){var t=el&&el.closest?el.closest('.tc'):null;if(!t||t.classList.contains('tc-plain'))return;t.classList.add('tc-plain');var port=t.querySelector('.tc-port');if(port)port.remove();var name=t.querySelector('.tc-name'),info=t.querySelector('.tc-info'),inn=t.querySelector('.tc-in');if(name&&info&&inn&&name.nextElementSibling===info)inn.insertBefore(info,name)}

// ---- HTML card
function spark(g){var v=vals(g);if(!v.length)return '';var mx=Math.max.apply(null,v.concat([g.line||0,1]))*1.15;
 return '<div class="tc-spark">'+(g.line!=null?'<i class="tc-sl" style="bottom:'+(g.line/mx*100)+'%"></i>':'')+v.map(function(x){return '<b class="'+(x>g.line?'o':x<g.line?'u':'p')+'" style="height:'+Math.max(4,x/mx*100)+'%"></b>'}).join('')+'</div>'}
function html(g){if(!g)return '';var t=tier(g.grade),u=g.pick==='UNDER',fo=t.foil.join(','),bk=esc(g.book||'PrizePicks'),pic=hasPic(g.player);
 var top='<div class="tc-top"><div class="tc-rate"><b>'+esc(g.grade)+'</b><span>'+t.name+'</span></div>'+
  '<div class="tc-logo'+(logoUrl(g.team)?'':' mono')+'" data-team="'+esc(g.team)+'">'+badge(g.team)+'<span>'+esc(mono(g.team))+'</span></div></div>';
 var name='<div class="tc-name"><b>'+esc(g.player)+'</b><span>'+esc(g.team||'')+(g.opp?' vs '+esc(g.opp):'')+' · '+bk+'</span></div>';
 var info='<div class="tc-info"><div class="tc-stat">'+esc(sname(g.stat))+' · Maps 1-2'+(g.lan?' · LAN data':'')+'</div><div class="tc-pick'+(u?' u':'')+'">'+esc(g.pick)+' '+esc(g.line)+'</div>'+
  '<div class="tc-proj"><span>PROJ</span><b>'+esc(g.proj)+'</b></div>'+'<div class="tc-meta">'+pct(g.pPick)+' chance · '+edge(g)+' edge · L10 '+l10(g)+'</div>'+spark(g)+'</div>';
 var port=pic?'<div class="tc-port"><div class="tc-pic"><img src="'+esc(photoSrc(g.player))+'" alt="" onerror="GPCards.dropPic(this)"></div></div>':'';
 var mid=pic?(port+top+name+info):(top+info+name);
 return '<div class="tc-wrap"><div class="tc t-'+(g.grade==='A+'?'ap':String(g.grade||'d').toLowerCase())+(pic?'':' tc-plain')+'" style="--foil:linear-gradient(135deg,'+fo+');--acc:'+t.accent+';--ink:'+t.ink+'">'+
 '<div class="tc-in"><div class="tc-pat" aria-hidden="true"></div><div class="tc-wm" aria-hidden="true">'+('GLOCKY PICKS   '.repeat(28))+'</div>'+mid+
 (function(){var q=pstats(g);return '<div class="tc-back"><div class="tc-bh">Season · Maps 1-2 · '+q.n+' series</div><div><b>'+q.hsp+'</b><i>HS%</i></div><div><b>'+q.kd+'</b><i>K/D</i></div><div><b>'+q.k1+'</b><i>Kills Map 1</i></div><div><b>'+q.hpm+'</b><i>HS / Map</i></div><div><b>'+q.kl10+'</b><i>Kills 1-2 L10</i></div><div><b>'+q.hsl10+'</b><i>HS 1-2 L10</i></div></div>'})()+
 '<div class="tc-foot"><span>GLOCKY PICKS</span><span>CS2 PROP GRADER</span></div></div></div></div>'}

// ---- image export (canvas, no libraries). 750x1050 = 2.5 x 3.5 in at 300 dpi.
var W=750,H=1050;
function rr(x,X,Y,w,h,r){x.beginPath();x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath()}
function grad(x,cols,x0,y0,x1,y1){var gr=x.createLinearGradient(x0,y0,x1,y1);cols.forEach(function(c,i){gr.addColorStop(i/(cols.length-1),c)});return gr}
function fit(x,t,size,maxW,weight){var f=function(){x.font=(weight||'')+' '+size+'px '+FONT};f();while(size>14&&x.measureText(t).width>maxW){size-=2;f()}return size}
function loadImg(src,cors,cb){if(!src)return cb(null);var im=new Image();if(cors)im.crossOrigin='anonymous';var done=false;function fin(v){if(!done){done=true;cb(v)}}im.onload=function(){fin(im)};im.onerror=function(){fin(null)};setTimeout(function(){fin(null)},4000);im.src=src}
function addRR(x,X,Y,w,h,r){x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath()}
// Framed portrait in the upper ~40% of the card. Inner fill is skipped so the GP tile already drawn on the panel shows around the cutout, not over the face.
function drawPort(x,pic,logo,g,t,P){var x0=P+14,y0=P+14,w=W-2*P-28,h=410,r=18;
 x.beginPath();addRR(x,x0-3,y0-3,w+6,h+6,r+3);addRR(x,x0,y0,w,h,r);x.fillStyle=grad(x,t.foil,x0,y0,x0+w,y0+h);x.fill('evenodd');
 x.save();rr(x,x0,y0,w,h,r);x.clip();
 if(pic&&pic.width){var s=Math.max(w/pic.width,(h*1.02)/pic.height),dw=pic.width*s,dh=pic.height*s,dx=x0+(w-dw)/2,dy=y0+4;
  x.shadowColor=t.accent;x.shadowBlur=28;x.drawImage(pic,dx,dy,dw,dh);x.shadowBlur=0}
 // soft corner scrims so the badges stay readable, kept well clear of the face
 var vg=x.createRadialGradient(x0,y0,8,x0,y0,130);vg.addColorStop(0,'rgba(0,0,0,.55)');vg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=vg;x.fillRect(x0,y0,150,140);
 vg=x.createRadialGradient(x0+w,y0,8,x0+w,y0,130);vg.addColorStop(0,'rgba(0,0,0,.55)');vg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=vg;x.fillRect(x0+w-150,y0,150,140);
 x.restore();
 // letter badge, top-left corner of the frame
 var bx=x0+12,by=y0+12,bs=92;x.textBaseline='alphabetic';x.textAlign='center';
 x.fillStyle=grad(x,t.foil,bx,by,bx+bs,by+bs);rr(x,bx,by,bs,bs,16);x.fill();
 x.fillStyle=t.ink;fit(x,g.grade,g.grade.length>1?42:50,76);x.fillText(g.grade,bx+bs/2,by+58);x.font='10px '+FONT;x.fillText(t.name,bx+bs/2,by+76);
 // team logo, top-right corner of the frame
 var lx=x0+w-12-42,ly=y0+12+42,lr=42;x.save();x.beginPath();x.arc(lx,ly,lr+6,0,7);x.fillStyle=grad(x,t.foil,lx-lr,ly-lr,lx+lr,ly+lr);x.fill();
 x.beginPath();x.arc(lx,ly,lr,0,7);x.fillStyle='#0d0d0d';x.fill();x.clip();
 if(logo){var ls=Math.min(lr*1.5/logo.width,lr*1.5/logo.height);x.drawImage(logo,lx-logo.width*ls/2,ly-logo.height*ls/2,logo.width*ls,logo.height*ls)}
 else{x.fillStyle=t.accent;var tm=mono(g.team);fit(x,tm,tm.length>2?26:32,lr*1.6);x.textBaseline='middle';x.fillText(tm,lx,ly+2);x.textBaseline='alphabetic'}
 x.restore();
 return y0+h}
function tilePat(x,tile,P){if(!tile)return;x.save();rr(x,P,P,W-2*P,H-2*P,30);x.clip();x.translate(W/2,H/2);x.rotate(-Math.PI/9);x.globalAlpha=.17;
 var tw=168,th=tw*tile.height/tile.width,gx=tw*1.15,gy=th*1.15;for(var row=0,yy=-H-gy;yy<H+gy;yy+=gy,row++){var ox=row%2?gx/2:0;for(var xx=-W-gx;xx<W+gx;xx+=gx)x.drawImage(tile,xx+ox-tw/2,yy-th/2,tw,th)}x.restore()}
function draw(g,logo,mark,tile,pic){var c=document.createElement('canvas');c.width=W;c.height=H;var x=c.getContext('2d'),t=tier(g.grade),u=g.pick==='UNDER',pc=u?'#ff4d6d':'#00FF66';
 x.fillStyle='#000';x.fillRect(0,0,W,H);
 // foil border + holo sheen
 rr(x,0,0,W,H,44);x.fillStyle=grad(x,t.foil,0,0,W,H);x.fill();
 if(g.grade==='A+'||g.grade==='F'){x.save();rr(x,0,0,W,H,44);x.clip();x.globalAlpha=.35;for(var i=-H;i<W+H;i+=70){x.fillStyle=i%140?'rgba(255,255,255,.55)':'rgba(120,255,240,.4)';x.beginPath();x.moveTo(i,0);x.lineTo(i+30,0);x.lineTo(i+30-H,H);x.lineTo(i-H,H);x.closePath();x.fill()}x.restore()}
 // inner panel
 var P=26;rr(x,P,P,W-2*P,H-2*P,30);var ig=x.createLinearGradient(0,P,0,H-P);ig.addColorStop(0,'#141414');ig.addColorStop(.55,'#0b0b0b');ig.addColorStop(1,'#060606');x.fillStyle=ig;x.fill();
 x.save();rr(x,P,P,W-2*P,H-2*P,30);x.clip();var rg=x.createRadialGradient(W/2,240,20,W/2,240,420);rg.addColorStop(0,t.accent+'40');rg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=rg;x.fillRect(0,0,W,H);
 x.strokeStyle='rgba(255,255,255,.035)';x.lineWidth=2;for(var j=-H;j<W;j+=26){x.beginPath();x.moveTo(j,P);x.lineTo(j+H,H);x.stroke()}
 tilePat(x,tile,P);
 // diagonal GLOCKY PICKS text sits on the panel only; the portrait is drawn on top so it does not cover the face
 x.translate(W/2,H/2);x.rotate(-Math.PI/5);x.font='54px '+FONT;x.fillStyle='rgba(255,255,255,.10)';x.textAlign='center';
 for(var r=-6;r<=6;r++)x.fillText('GLOCKY PICKS   GLOCKY PICKS   GLOCKY PICKS',0,r*150);x.restore();
 x.strokeStyle=t.accent;x.globalAlpha=.6;x.lineWidth=3;rr(x,P+10,P+10,W-2*P-20,H-2*P-20,24);x.stroke();x.globalAlpha=1;
 var has=pic&&pic.width,ny,nh,iy,sx=80,sw=W-160,sy,sh,gy,gh;
 x.textAlign='center';x.textBaseline='alphabetic';
 if(has){
  var pb=drawPort(x,pic,logo,g,t,P);
  ny=pb+10;nh=68;iy=ny+nh+22;sy=iy+112;sh=64;gy=sy+sh+42;gh=44;
  drawName(x,g,t,P,ny,nh,40,16);
  drawPick(x,g,pc,iy,16,48,15,32,15);
 }else{
  // No cached photo: skip the portrait window and use the compact badge + pick + bars + name layout.
  drawBadges(x,logo,g,t);
  iy=250;sy=448;sh=126;ny=610;nh=80;gy=716;gh=54;
  drawPick(x,g,pc,iy,20,72,18,44,20);
  drawName(x,g,t,P,ny,nh,46,18);
 }
 var v=vals(g);if(v.length){var mx=Math.max.apply(null,v.concat([g.line||0,1]))*1.15,bw=sw/v.length;
  v.forEach(function(val,k){var bh=Math.max(5,val/mx*sh);x.fillStyle=val>g.line?'#00FF66':val<g.line?'#ff4d6d':'#777';rr(x,sx+k*bw+4,sy+sh-bh,bw-8,bh,4);x.fill()});
  var ly=sy+sh-g.line/mx*sh;x.setLineDash([8,6]);x.strokeStyle='#fff';x.lineWidth=2;x.beginPath();x.moveTo(sx-4,ly);x.lineTo(sx+sw+4,ly);x.stroke();x.setLineDash([]);
  x.fillStyle='#8b9297';x.font=(has?12:14)+'px '+FONT;x.fillText('LAST '+v.length+' SERIES  ·  DASHED = LINE',W/2,sy+sh+18)}
 var q=pstats(g);
 x.fillStyle='#8b9297';x.font=(has?13:15)+'px '+FONT;x.fillText('SEASON  ·  MAPS 1-2  ·  '+q.n+' SERIES',W/2,gy);
 var cells=[[q.hsp,'HS%'],[q.kd,'K/D'],[q.k1,'KILLS MAP 1'],[q.hpm,'HS / MAP'],[q.kl10,'KILLS 1-2 L10'],[q.hsl10,'HS 1-2 L10']],gx=P+14,gw=(W-2*P-28-8)/2,cy0=gy+10,gap=has?6:8,cf=has?13:15,vf=has?26:30;
 cells.forEach(function(cl,k){var cx=gx+(k%2)*(gw+8),cy=cy0+Math.floor(k/2)*(gh+gap);
  x.fillStyle='rgba(255,255,255,.06)';rr(x,cx,cy,gw,gh,10);x.fill();
  x.strokeStyle=t.accent;x.globalAlpha=.35;x.lineWidth=2;rr(x,cx,cy,gw,gh,10);x.stroke();x.globalAlpha=1;
  x.textAlign='left';x.fillStyle='#8b9297';x.font=cf+'px '+FONT;x.fillText(cl[1],cx+14,cy+Math.round(gh*0.64));x.textAlign='right';x.fillStyle='#fff';x.font=vf+'px '+FONT;x.fillText(cl[0],cx+gw-14,cy+Math.round(gh*0.72));x.textAlign='center'});
 if(mark){x.save();x.globalAlpha=.9;var mh=32,mw=mh*mark.width/mark.height;x.drawImage(mark,P+34,H-P-mh-12,mw,mh);x.restore()}
 x.textAlign='left';x.fillStyle='#00FF66';x.shadowColor='#00FF66';x.shadowBlur=12;x.font='20px '+FONT;x.fillText('GLOCKY PICKS',P+(mark?34+32*mark.width/mark.height+10:36),H-P-20);x.shadowBlur=0;
 x.textAlign='right';x.fillStyle='#8b9297';x.font='16px '+FONT;x.fillText('@GLOCKYPICKZ',W-P-36,H-P-20);
 return c}
function drawBadges(x,logo,g,t){var bx=58,by=56,bs=150;x.textBaseline='alphabetic';x.textAlign='center';
 x.fillStyle=grad(x,t.foil,bx,by,bx+bs,by+bs);rr(x,bx,by,bs,bs,24);x.fill();
 x.fillStyle=t.ink;fit(x,g.grade,g.grade.length>1?88:102,130);x.fillText(g.grade,bx+bs/2,by+98);x.font='16px '+FONT;x.fillText(t.name,bx+bs/2,by+126);
 var lx=W-58-70,ly=by+70,lr=70;x.save();x.beginPath();x.arc(lx,ly,lr+7,0,7);x.fillStyle=grad(x,t.foil,lx-lr,ly-lr,lx+lr,ly+lr);x.fill();
 x.beginPath();x.arc(lx,ly,lr,0,7);x.fillStyle='#0d0d0d';x.fill();x.clip();
 if(logo){var ls=Math.min(lr*1.5/logo.width,lr*1.5/logo.height);x.drawImage(logo,lx-logo.width*ls/2,ly-logo.height*ls/2,logo.width*ls,logo.height*ls)}
 else{x.fillStyle=t.accent;var tm=mono(g.team);fit(x,tm,tm.length>2?36:46,lr*1.6);x.textBaseline='middle';x.fillText(tm,lx,ly+2);x.textBaseline='alphabetic'}
 x.restore()}
function drawName(x,g,t,P,ny,nh,nf,sf){x.fillStyle=grad(x,t.foil,P,ny,W-P,ny+nh);rr(x,P+14,ny,W-2*P-28,nh,14);x.fill();x.fillStyle='rgba(0,0,0,.55)';rr(x,P+18,ny+3,W-2*P-36,nh-6,12);x.fill();
 x.textAlign='center';x.fillStyle='#fff';fit(x,String(g.player).toUpperCase(),nf,W-2*P-80);x.fillText(String(g.player).toUpperCase(),W/2,ny+Math.round(nh*0.56));
 var bk=(g.book||'PrizePicks').toUpperCase();var sub=(g.team||'')+(g.opp?'  vs  '+g.opp:'')+'  ·  '+bk;x.fillStyle=t.accent;fit(x,sub,sf,W-2*P-80);x.fillText(sub,W/2,ny+Math.round(nh*0.84))}
function drawPick(x,g,pc,iy,statSize,pickSize,plSize,projSize,metaSize){
 x.fillStyle='#c8cdd2';x.font=statSize+'px '+FONT;x.fillText((sname(g.stat)+' · Maps 1-2').toUpperCase(),W/2,iy);
 var pk=g.pick+' '+g.line;x.shadowColor=pc;x.shadowBlur=20;x.fillStyle=pc;fit(x,pk,pickSize,640);x.fillText(pk,W/2,iy+44+(pickSize>60?16:0));x.shadowBlur=0;
 x.font=plSize+'px '+FONT;var pl='PROJ ',pw=x.measureText(pl).width;x.font=projSize+'px '+FONT;var pv=String(g.proj),vw=x.measureText(pv).width;var px0=W/2-(pw+vw)/2,py=iy+(pickSize>60?116:76);
 x.textAlign='left';x.fillStyle='#8b9297';x.font=plSize+'px '+FONT;x.fillText(pl,px0,py);x.fillStyle='#fff';x.font=projSize+'px '+FONT;x.fillText(pv,px0+pw,py);x.textAlign='center';
 x.fillStyle='#c8cdd2';x.font=metaSize+'px '+FONT;x.fillText(pct(g.pPick)+' CHANCE  ·  '+edge(g)+' EDGE  ·  L10 '+l10(g),W/2,py+28)}
function fontReady(cb){var d=false;function go(){if(!d){d=true;cb()}}setTimeout(go,1500);try{document.fonts.load('60px "Russo One"').then(go,go)}catch(e){go()}}
// cb(canvas). Draws with the team logo when it can; if the logo would block the export (no CORS), redraws with the monogram.
function img(g,cb){fontReady(function(){whenLogos(function(){whenPhotos(function(){loadImg(logoUrl(g.team),true,function(logo){loadImg('assets/logo.png',false,function(mark){loadImg('assets/logo-tile.png',false,function(tile){loadImg(photoSrc(g.player),false,function(pic){
 var c=draw(g,logo,mark,tile,pic);if(logo||pic){try{c.getContext('2d').getImageData(0,0,1,1)}catch(e){c=draw(g,null,mark,tile,null)}}cb(c)})})})})})})})}
loadLogos();loadPhotos();
window.GPCards={html:html,img:img,logoUrl:logoUrl,hasPic:hasPic,dropPic:dropPic};
})();
