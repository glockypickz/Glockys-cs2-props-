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
// HS% = headshots / kills; K/D = kills / deaths; Kills Map 1 = average Map 1 kills (l.n===1, not Maps 1-2 / 2);
// HS / MAP = season average of (Map 1 HS + Map 2 HS) / 2 per series; Kills/HS 1-2 L10 = average total Maps 1-2 kills/headshots over the last 10 series.
function pstats(g){var cs=g.cs||[],k=0,n=0,hk=0,hh=0,nh=0,dk=0,dd=0,k1=0,n1=0;cs.forEach(function(c){if(c.kills==null)return;k+=c.kills;n++;if(c.hs!=null){hh+=c.hs;hk+=c.kills;nh++}if(c.deaths!=null){dk+=c.kills;dd+=c.deaths}if(c.kills1!=null){k1+=c.kills1;n1++}});
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

// ---- HTML card
function spark(g){var v=vals(g);if(!v.length)return '';var mx=Math.max.apply(null,v.concat([g.line||0,1]))*1.15;
 return '<div class="tc-spark">'+(g.line!=null?'<i class="tc-sl" style="bottom:'+(g.line/mx*100)+'%"></i>':'')+v.map(function(x){return '<b class="'+(x>g.line?'o':x<g.line?'u':'p')+'" style="height:'+Math.max(4,x/mx*100)+'%"></b>'}).join('')+'</div>'}
function html(g){if(!g)return '';var t=tier(g.grade),u=g.pick==='UNDER',fo=t.foil.join(',');
 return '<div class="tc-wrap"><div class="tc t-'+(g.grade==='A+'?'ap':String(g.grade||'d').toLowerCase())+'" style="--foil:linear-gradient(135deg,'+fo+');--acc:'+t.accent+';--ink:'+t.ink+'">'+
 '<div class="tc-in"><div class="tc-pat" aria-hidden="true"></div><div class="tc-wm" aria-hidden="true">'+('GLOCKY PICKS   '.repeat(28))+'</div><div class="tc-top"><div class="tc-rate"><b>'+esc(g.grade)+'</b><span>'+t.name+'</span></div>'+
 '<div class="tc-logo'+(logoUrl(g.team)?'':' mono')+'" data-team="'+esc(g.team)+'">'+badge(g.team)+'<span>'+esc(mono(g.team))+'</span></div></div>'+
 '<div class="tc-art"><div class="tc-stat">'+esc(sname(g.stat))+' · Maps 1-2</div><div class="tc-pick'+(u?' u':'')+'">'+esc(g.pick)+' '+esc(g.line)+'</div>'+
 '<div class="tc-proj"><span>PROJ</span><b>'+esc(g.proj)+'</b></div>'+'<div class="tc-meta">'+pct(g.pPick)+' chance · '+edge(g)+' edge · L10 '+l10(g)+'</div>'+spark(g)+'<div class="tc-book">'+esc(g.book||'PrizePicks')+'</div></div>'+
 '<div class="tc-name"><b>'+esc(g.player)+'</b><span>'+esc(g.team||'')+(g.opp?' vs '+esc(g.opp):'')+'</span></div>'+
 (function(){var q=pstats(g);return '<div class="tc-back"><div class="tc-bh">Season · Maps 1-2 · '+q.n+' series</div><div><b>'+q.hsp+'</b><i>HS%</i></div><div><b>'+q.kd+'</b><i>K/D</i></div><div><b>'+q.k1+'</b><i>Kills Map 1</i></div><div><b>'+q.hpm+'</b><i>HS / Map</i></div><div><b>'+q.kl10+'</b><i>Kills 1-2 L10</i></div><div><b>'+q.hsl10+'</b><i>HS 1-2 L10</i></div></div>'})()+
 '<div class="tc-foot"><span>GLOCKY PICKS</span><span>CS2 PROP GRADER</span></div></div></div></div>'}

// ---- image export (canvas, no libraries). 750x1050 = 2.5 x 3.5 in at 300 dpi.
var W=750,H=1050;
function rr(x,X,Y,w,h,r){x.beginPath();x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath()}
function grad(x,cols,x0,y0,x1,y1){var gr=x.createLinearGradient(x0,y0,x1,y1);cols.forEach(function(c,i){gr.addColorStop(i/(cols.length-1),c)});return gr}
function fit(x,t,size,maxW,weight){var f=function(){x.font=(weight||'')+' '+size+'px '+FONT};f();while(size>14&&x.measureText(t).width>maxW){size-=2;f()}return size}
function loadImg(src,cors,cb){if(!src)return cb(null);var im=new Image();if(cors)im.crossOrigin='anonymous';var done=false;function fin(v){if(!done){done=true;cb(v)}}im.onload=function(){fin(im)};im.onerror=function(){fin(null)};setTimeout(function(){fin(null)},4000);im.src=src}
function tilePat(x,tile,P){if(!tile)return;x.save();rr(x,P,P,W-2*P,H-2*P,30);x.clip();x.translate(W/2,H/2);x.rotate(-Math.PI/9);x.globalAlpha=.17;
 var tw=168,th=tw*tile.height/tile.width,gx=tw*1.15,gy=th*1.15;for(var row=0,yy=-H-gy;yy<H+gy;yy+=gy,row++){var ox=row%2?gx/2:0;for(var xx=-W-gx;xx<W+gx;xx+=gx)x.drawImage(tile,xx+ox-tw/2,yy-th/2,tw,th)}x.restore()}
function draw(g,logo,mark,tile){var c=document.createElement('canvas');c.width=W;c.height=H;var x=c.getContext('2d'),t=tier(g.grade),u=g.pick==='UNDER',pc=u?'#ff4d6d':'#00FF66';
 x.fillStyle='#000';x.fillRect(0,0,W,H);
 // foil border + holo sheen
 rr(x,0,0,W,H,44);x.fillStyle=grad(x,t.foil,0,0,W,H);x.fill();
 if(g.grade==='A+'||g.grade==='F'){x.save();rr(x,0,0,W,H,44);x.clip();x.globalAlpha=.35;for(var i=-H;i<W+H;i+=70){x.fillStyle=i%140?'rgba(255,255,255,.55)':'rgba(120,255,240,.4)';x.beginPath();x.moveTo(i,0);x.lineTo(i+30,0);x.lineTo(i+30-H,H);x.lineTo(i-H,H);x.closePath();x.fill()}x.restore()}
 // inner panel
 var P=26;rr(x,P,P,W-2*P,H-2*P,30);var ig=x.createLinearGradient(0,P,0,H-P);ig.addColorStop(0,'#141414');ig.addColorStop(.55,'#0b0b0b');ig.addColorStop(1,'#060606');x.fillStyle=ig;x.fill();
 x.save();rr(x,P,P,W-2*P,H-2*P,30);x.clip();var rg=x.createRadialGradient(W/2,380,20,W/2,380,420);rg.addColorStop(0,t.accent+'40');rg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=rg;x.fillRect(0,0,W,H);
 x.strokeStyle='rgba(255,255,255,.035)';x.lineWidth=2;for(var j=-H;j<W;j+=26){x.beginPath();x.moveTo(j,P);x.lineTo(j+H,H);x.stroke()}
 tilePat(x,tile,P);x.restore();
 x.strokeStyle=t.accent;x.globalAlpha=.6;x.lineWidth=3;rr(x,P+10,P+10,W-2*P-20,H-2*P-20,24);x.stroke();x.globalAlpha=1;
 // rating gem (top-left)
 x.textBaseline='alphabetic';x.textAlign='center';x.fillStyle=grad(x,t.foil,60,60,230,230);rr(x,62,62,170,170,26);x.fill();
 x.fillStyle=t.ink;fit(x,g.grade,g.grade.length>1?108:128,150);x.fillText(g.grade,147,190);x.font='20px '+FONT;x.fillText(t.name,147,220);
 // logo badge (top-right)
 var bx=W-150,by=147,br=82;x.save();x.beginPath();x.arc(bx,by,br+8,0,7);x.fillStyle=grad(x,t.foil,bx-br,by-br,bx+br,by+br);x.fill();x.beginPath();x.arc(bx,by,br,0,7);x.fillStyle='#0d0d0d';x.fill();x.clip();
 if(logo){var s=Math.min(br*1.5/logo.width,br*1.5/logo.height);x.drawImage(logo,bx-logo.width*s/2,by-logo.height*s/2,logo.width*s,logo.height*s)}
 else{x.fillStyle=t.accent;var m=mono(g.team);fit(x,m,m.length>2?54:66,br*1.6);x.textBaseline='middle';x.fillText(m,bx,by+3);x.textBaseline='alphabetic'}x.restore();
 // art window: stat, pick, projection, sparkline
 x.fillStyle='#c8cdd2';x.font='26px '+FONT;x.fillText((sname(g.stat)+' · Maps 1-2').toUpperCase(),W/2,290);
 var pk=g.pick+' '+g.line;x.shadowColor=pc;x.shadowBlur=26;x.fillStyle=pc;fit(x,pk,86,600);x.fillText(pk,W/2,372);x.shadowBlur=0;
 x.font='22px '+FONT;var pl='PROJ ',pw=x.measureText(pl).width;x.font='50px '+FONT;var pv=String(g.proj),vw=x.measureText(pv).width;var px0=W/2-(pw+vw)/2;
 x.textAlign='left';x.fillStyle='#8b9297';x.font='22px '+FONT;x.fillText(pl,px0,428);x.fillStyle='#fff';x.font='50px '+FONT;x.fillText(pv,px0+pw,428);x.textAlign='center';
 x.fillStyle='#c8cdd2';x.font='21px '+FONT;x.fillText(pct(g.pPick)+' CHANCE  ·  '+edge(g)+' EDGE  ·  L10 '+l10(g),W/2,466);
 var v=vals(g),sx=120,sw=W-240,sy=488,sh=100;if(v.length){var mx=Math.max.apply(null,v.concat([g.line||0,1]))*1.15,bw=sw/v.length;
  v.forEach(function(val,k){var h=Math.max(6,val/mx*sh);x.fillStyle=val>g.line?'#00FF66':val<g.line?'#ff4d6d':'#777';rr(x,sx+k*bw+5,sy+sh-h,bw-10,h,5);x.fill()});
  var ly=sy+sh-g.line/mx*sh;x.setLineDash([10,8]);x.strokeStyle='#fff';x.lineWidth=3;x.beginPath();x.moveTo(sx-6,ly);x.lineTo(sx+sw+6,ly);x.stroke();x.setLineDash([]);
  x.fillStyle='#8b9297';x.font='17px '+FONT;x.fillText('LAST '+v.length+' SERIES  ·  DASHED = LINE',W/2,sy+sh+26)}
 var bk=(g.book||'PrizePicks').toUpperCase();
 // name plate
 var ny=632;x.fillStyle=grad(x,t.foil,P,ny,W-P,ny+88);rr(x,P+30,ny,W-2*P-60,88,16);x.fill();x.fillStyle='rgba(0,0,0,.55)';rr(x,P+34,ny+4,W-2*P-68,80,13);x.fill();
 x.fillStyle='#fff';fit(x,String(g.player).toUpperCase(),52,W-2*P-110);x.fillText(String(g.player).toUpperCase(),W/2,ny+50);
 var sub=(g.team||'')+(g.opp?'  vs  '+g.opp:'')+'  ·  '+bk;x.fillStyle=t.accent;fit(x,sub,21,W-2*P-110);x.fillText(sub,W/2,ny+76);
 // card back: season player stats, 2 x 3
 var q=pstats(g);x.fillStyle='#8b9297';x.font='16px '+FONT;x.fillText('SEASON  ·  MAPS 1-2  ·  '+q.n+' SERIES',W/2,ny+118);
 var cells=[[q.hsp,'HS%'],[q.kd,'K/D'],[q.k1,'KILLS MAP 1'],[q.hpm,'HS / MAP'],[q.kl10,'KILLS 1-2 L10'],[q.hsl10,'HS 1-2 L10']],gx=P+30,gw=(W-2*P-60-12)/2,gy=ny+130,gh=58,gap=8;
 cells.forEach(function(cl,k){var cx=gx+(k%2)*(gw+12),cy=gy+Math.floor(k/2)*(gh+gap);
  x.fillStyle='rgba(255,255,255,.06)';rr(x,cx,cy,gw,gh,12);x.fill();
  x.strokeStyle=t.accent;x.globalAlpha=.35;x.lineWidth=2;rr(x,cx,cy,gw,gh,12);x.stroke();x.globalAlpha=1;
  x.textAlign='left';x.fillStyle='#8b9297';x.font='17px '+FONT;x.fillText(cl[1],cx+18,cy+36);x.textAlign='right';x.fillStyle='#fff';x.font='34px '+FONT;x.fillText(cl[0],cx+gw-18,cy+42);x.textAlign='center'});
 // watermark: diagonal GLOCKY PICKS text (kept, slightly stronger) over the GP logo tile already in the panel
 x.save();rr(x,P,P,W-2*P,H-2*P,30);x.clip();x.translate(W/2,H/2);x.rotate(-Math.PI/5);x.font='54px '+FONT;x.fillStyle='rgba(255,255,255,.10)';
 for(var r=-6;r<=6;r++)x.fillText('GLOCKY PICKS   GLOCKY PICKS   GLOCKY PICKS',0,r*150);x.restore();
 if(mark){x.save();x.globalAlpha=.9;var mh=40,mw=mh*mark.width/mark.height;x.drawImage(mark,P+34,H-P-mh-14,mw,mh);x.restore()}
 x.textAlign='left';x.fillStyle='#00FF66';x.shadowColor='#00FF66';x.shadowBlur=12;x.font='24px '+FONT;x.fillText('GLOCKY PICKS',P+(mark?34+40*mark.width/mark.height+12:36),H-P-24);x.shadowBlur=0;
 x.textAlign='right';x.fillStyle='#8b9297';x.font='18px '+FONT;x.fillText('@GLOCKYPICKZ',W-P-36,H-P-24);
 return c}
function fontReady(cb){var d=false;function go(){if(!d){d=true;cb()}}setTimeout(go,1500);try{document.fonts.load('60px "Russo One"').then(go,go)}catch(e){go()}}
// cb(canvas). Draws with the team logo when it can; if the logo would block the export (no CORS), redraws with the monogram.
function img(g,cb){fontReady(function(){whenLogos(function(){loadImg(logoUrl(g.team),true,function(logo){loadImg('assets/logo.png',false,function(mark){loadImg('assets/logo-tile.png',false,function(tile){
 var c=draw(g,logo,mark,tile);if(logo){try{c.getContext('2d').getImageData(0,0,1,1)}catch(e){c=draw(g,null,mark,tile)}}cb(c)})})})})})}
loadLogos();
window.GPCards={html:html,img:img,logoUrl:logoUrl};
})();
