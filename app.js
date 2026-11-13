(function(){
'use strict';
var $=function(i){return document.getElementById(i)};
var DB=[],RANK={},GAMES=[],LINES=[],HIST=null,META={updated:'',lines_at:'',games_at:'',games_iso:''};
var TABS=[['dash','⌂','Dashboard'],['games','▦','Games'],['lines','↗','Lines'],['grader','⚡','Grader'],['slip','◎','Slip'],['players','☰','Players']];
var tab='dash',slip=[],manual=[],sel={player:'',stat:'kills',line:'',opp:''};
function load(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function save(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
slip=load('gp_slip',[]);manual=load('gp_manual',[]);
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
// ---- time: always 12-hour AM/PM, Central Time
function fmt(iso){if(!iso)return '';var d=new Date(iso);if(isNaN(d))return '';
 return new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).format(d).replace(',',' •').replace(/,/,'')+' CT'}
function ftime(iso){var d=iso?new Date(iso):new Date();return new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',hour12:true}).format(d)}
function toast(m){var t=$('toast');t.textContent=m;t.classList.remove('hide');clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.add('hide')},2600)}
// ---- stats
function combos(p){var by={};(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&l.mid!=null){var g=by[l.mid]=by[l.mid]||{mid:l.mid,date:l.date,opp:l.opp,m:{},kills:0,hs:0,hsOk:true,d:0,dOk:true,a:0,aOk:true,adr:[],ev:{},x:{}};g.m[l.n]=l.map;g.kills+=Number(l.kills)||0;
 if(l.hs==null)g.hsOk=false;else g.hs+=Number(l.hs)||0;if(l.d==null)g.dOk=false;else g.d+=Number(l.d)||0;if(l.a==null)g.aOk=false;else g.a+=Number(l.a)||0;if(l.adr!=null)g.adr.push(Number(l.adr));if(l.ev)g.ev[l.ev]=1;
 if(l.x)for(var k in l.x){(g.x[k]=g.x[k]||[]).push(l.x[k])}}});
 return Object.keys(by).map(function(k){return by[k]}).filter(function(g){return g.m[1]&&g.m[2]}).map(function(g){var evs=Object.keys(g.ev),x={};for(var k in g.x)x[k]=g.x[k].reduce(function(a,b){return a+b},0);
  return{mid:g.mid,date:g.date,opp:g.opp,maps:g.m[1]+' + '+g.m[2],kills:g.kills,hs:g.hsOk?g.hs:null,deaths:g.dOk?g.d:null,assists:g.aOk?g.a:null,adr:g.adr.length?g.adr.reduce(function(a,b){return a+b},0)/g.adr.length:null,ev:evs.length===1?evs[0]:null,x:x}}).sort(function(a,b){return a.date<b.date?1:a.date>b.date?-1:(String(a.mid)<String(b.mid)?1:String(a.mid)>String(b.mid)?-1:0)})}
function mean(a){return a.length?a.reduce(function(x,y){return x+y},0)/a.length:null}
function sd(a){var m=mean(a);return a.length?Math.sqrt(mean(a.map(function(x){return (x-m)*(x-m)}))):0}
function nums(cs,st){return cs.map(function(c){return c[st]}).filter(function(x){return x!=null})}
function tier(r){return r<=5?'Top 5':r<=15?'Top 6-15':r<=30?'Top 16-30':'Top 31+'}
// ---- days (Central), team matching, live status
function cday(iso){var d=iso?new Date(iso):new Date();if(isNaN(d))return '';var o={};new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).forEach(function(p){o[p.type]=p.value});return o.year+'-'+o.month+'-'+o.day}
function addDays(ymd,n){var d=new Date(ymd+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function dayLabel(ymd){var t=cday();if(ymd===t)return 'Today';if(ymd===addDays(t,1))return 'Tomorrow';return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(ymd+'T12:00:00Z'))}
function teq(a,b){a=norm(a).replace(/^team/,'');b=norm(b).replace(/^team/,'');return !!a&&a===b}
function NOW(){return Date.now()}
function boN(b){var n=parseInt(String(b==null?'':b).replace(/\D/g,''),10);return isNaN(n)?null:n}
function isLive(g){if(g.status!=='live')return false;var n=boN(g.bo),age=(NOW()-new Date(g.start).getTime())/3600000;
 if(n&&n>=3&&g.s1!=null&&g.s2!=null&&Math.max(g.s1,g.s2)>=Math.floor(n/2)+1)return false;
 return age<({1:3,3:8,5:12}[n]||12)}
function isUp(g){if(g.status==='live'||g.status==='finished')return false;return new Date(g.start).getTime()>NOW()-10*60000}
function liveGames(){return GAMES.filter(isLive)}
function upGames(){return GAMES.filter(isUp)}
function liveFor(team){return liveGames().some(function(g){return teq(g.team1,team)||teq(g.team2,team)})}
function gamesAge(){var u=META.games_iso;if(!u||u.indexOf('T')<0)return null;var m=(NOW()-new Date(u).getTime())/60000;return isNaN(m)?null:m}
function rankOf(name){var k=norm(name);for(var t in RANK)if(norm(t)===k)return RANK[t];return null}
// ---- player matching: exact name first, then safe fallbacks (so spelling differences between the lines feed and the stats still match)
// ALIASES: add "name on the lines" : "name in the stats" for any player the automatic rules can't or shouldn't match.
var ALIASES={"4Z":"EP.-4Z"};
function canon(s){var k=norm(s).replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e').replace(/4/g,'a').replace(/5/g,'s').replace(/7/g,'t');return k.replace(/(.)\1+/g,'$1')}
var IDX=null,IDXN=-1,FM={};
function pIndex(){if(IDX&&IDXN===DB.length)return IDX;IDX={exact:{},canon:{}};IDXN=DB.length;FM={};
 DB.forEach(function(p){var e=norm(p.name),c=canon(p.name);(IDX.exact[e]=IDX.exact[e]||[]).push(p);(IDX.canon[c]=IDX.canon[c]||[]).push(p)});return IDX}
function nlogs(p){return (p.logs||[]).length}
function pickBest(a){return a.slice().sort(function(x,y){return nlogs(y)-nlogs(x)})[0]}
function find(name,team){
 var ix=pIndex(),k=norm(name),mk=k+'|'+norm(team||'');if(mk in FM)return FM[mk];
 var r=null,ex=ix.exact[k];
 if(ex){r=(team&&ex.filter(function(p){return teq(p.team,team)})[0])||pickBest(ex)}
 if(!r&&ALIASES[name]){var a=ix.exact[norm(ALIASES[name])];if(a)r=pickBest(a)}
 if(!r&&k.length>=3){
  var cs=ix.canon[canon(name)];
  if(cs){var same=team?cs.filter(function(p){return teq(p.team,team)}):[];var pool=same.length?same:cs;if(pool.length===1||same.length===1)r=pool[0]}
 }
 if(!r&&team){ // same team only: one name contained in the other (tags like "EP.-4Z"), real history required
  var c=canon(name),cand=DB.filter(function(p){if(!teq(p.team,team)||nlogs(p)<6)return false;var d=canon(p.name),sh=d.length<c.length?d:c,lo=d.length<c.length?c:d;return sh.length>=4&&lo.indexOf(sh)>-1});
  if(cand.length===1)r=cand[0]}
 FM[mk]=r||undefined;return FM[mk]}
// ---- grader: 35% recent 10, 20% career (all logged), 20% H2H, 15% vs same rank tier, 10% form/context (last 3)
function grade(p,st,line,opp){var cs=combos(p);var v=nums(cs,st);if(!v.length||isNaN(line))return null;
 var oppRank=opp?rankOf(opp):null,oppN=norm(opp);
 var comp=[{k:'Recent (last 10)',w:.35,v:mean(nums(cs.slice(0,10),st)),n:Math.min(10,v.length)},
  {k:'Career (all logged)',w:.20,v:mean(v),n:v.length}];
 var h=opp?cs.filter(function(c){return norm(c.opp)===oppN}):[];comp.push({k:'H2H vs '+(opp||'opponent'),w:.20,v:mean(nums(h,st)),n:nums(h,st).length});
 var same=oppRank?cs.filter(function(c){var r=rankOf(c.opp);return r&&tier(r)===tier(oppRank)}):[];comp.push({k:'Vs same rank'+(oppRank?' ('+tier(oppRank)+')':''),w:.15,v:mean(nums(same,st)),n:nums(same,st).length});
 comp.push({k:'Form (last 3)',w:.10,v:mean(nums(cs.slice(0,3),st)),n:Math.min(3,v.length)});
 var use=comp.filter(function(c){return c.v!=null}),tw=use.reduce(function(a,c){return a+c.w},0);
 var proj=use.reduce(function(a,c){return a+c.v*c.w/tw},0);
 var ar=mean(cs.slice(0,5).map(function(c){return c.adr}).filter(function(x){return x!=null})),ac=mean(cs.map(function(c){return c.adr}).filter(function(x){return x!=null})),ff=1;
 if(ar!=null&&ac){ff=Math.max(.95,Math.min(1.05,1+0.5*(ar/ac-1)));proj*=ff}
 var adjNote=ar!=null&&ac?'Form factor from ADR (last 5 '+ar.toFixed(0)+' vs career '+ac.toFixed(0)+'): x'+ff.toFixed(3)+', capped at +/-5%':'No ADR in the data yet, so no form factor applied';
 var edge=proj-line,pct=edge/line;
 var g=pct>=.15?'A+':pct>=.05?'B':pct>=-.02?'C':pct>=-.10?'D':'F';
 var last=nums(cs.slice(0,10),st),over=last.filter(function(x){return x>line}).length;
 var label={'A+':'Excellent Over','B':'Lean Over','C':'Risk Lean Over','D':'Lean Under','F':'Terrible Take Under'}[g];
 return{player:p.name,team:p.team,stat:st,line:line,opp:opp||'',proj:+proj.toFixed(1),edge:+edge.toFixed(1),grade:g,label:label,pick:edge>=0?'OVER':'UNDER',comp:comp,over:over,of:last.length,sd:+sd(last).toFixed(1),cs:cs,adj:adjNote}}
// ---- combo props ("A + B + C"): sum of each player's own projection vs the combined line
function isCombo(n){return String(n||'').indexOf('+')>-1}
function gradeCombo(name,team,st,line,opp){
 var names=String(name).split('+').map(function(x){return x.trim()}).filter(Boolean);if(names.length<2||isNaN(line))return null;
 var parts=[],proj=0,series=[];
 for(var i=0;i<names.length;i++){var p=find(names[i],team);if(!p)return{missing:names[i]};var g=grade(p,st,1,opp);if(!g)return{missing:names[i]};
  parts.push({name:p.name,proj:g.proj,n:g.cs.length});proj+=g.proj;series.push(g.cs)}
 var joint=[];if(series.length){series[0].forEach(function(c0){var rows=[c0],ok=true;for(var j=1;j<series.length;j++){var m=series[j].filter(function(c){return String(c.mid)===String(c0.mid)})[0];if(!m){ok=false;break}rows.push(m)}
  if(!ok||rows.some(function(r){return r[st]==null}))return;joint.push({mid:c0.mid,date:c0.date,opp:c0.opp,maps:c0.maps,kills:rows.reduce(function(a,r){return a+r.kills},0),hs:rows.every(function(r){return r.hs!=null})?rows.reduce(function(a,r){return a+r.hs},0):null})})}
 proj=+proj.toFixed(1);var edge=proj-line,pct=edge/line;
 var gr=pct>=.15?'A+':pct>=.05?'B':pct>=-.02?'C':pct>=-.10?'D':'F';
 var label={'A+':'Excellent Over','B':'Lean Over','C':'Risk Lean Over','D':'Lean Under','F':'Terrible Take Under'}[gr];
 var last=nums(joint.slice(0,10),st),over=last.filter(function(x){return x>line}).length;
 return{player:name,team:team||'',stat:st,line:line,opp:opp||'',proj:proj,edge:+edge.toFixed(1),grade:gr,label:label,pick:edge>=0?'OVER':'UNDER',
  comp:parts.map(function(x){return{k:x.name+' projection',w:null,v:x.proj,n:x.n}}),over:over,of:last.length,sd:+sd(last).toFixed(1),cs:joint,
  adj:'Combo: the sum of each player\'s own projection ('+parts.map(function(x){return x.name+' '+x.proj}).join(' + ')+'). Chart and over count use only series where all '+names.length+' played together'+(joint.length?' ('+joint.length+' found)':' (none found yet)')}}
function gradeFor(name,team,st,line,opp){if(isCombo(name))return gradeCombo(name,team,st,line,opp);var p=find(name,team);return p?grade(p,st,line,opp):null}
function gclass(g){return g==='A+'||g==='B'?'':g==='C'?' mid':' low'}
function sname(s){return s==='hs'?'Headshots Maps 1-2':'Kills Maps 1-2'}
function normStat(s){s=String(s||'').toLowerCase();return s.indexOf('head')>-1||s==='hs'?'hs':s.indexOf('kill')>-1?'kills':null}
// ---- all lines = feed + manual
function allLines(){var out=[];LINES.concat(manual).forEach(function(l,i){var st=normStat(l.stat);if(!st)return;var per=String(l.period||'Maps 1-2');if(per.replace(/\s/g,'').toLowerCase().indexOf('maps1-2')<0&&per.indexOf('1-2')<0&&l.src!=='manual')return;
 var combo=isCombo(l.player),p=combo?null:find(l.player,l.team);var o={player:l.player,team:l.team||(p&&p.team)||'',stat:st,line:+l.line,opp:l.opponent||'',src:l.src||'feed',idx:i,book:l.book||'',start:l.starts_at||''};var G=gradeFor(l.player,l.team,st,o.line,o.opp);o.g=G&&!G.missing?G:null;o.miss=G&&G.missing?G.missing:'';out.push(o)});return out}
// ---- views
function chips(){var c=[];c.push('<span class="chip g">'+DB.length+' players</span>');c.push('<span class="chip">Stats updated '+esc(META.updated||'—')+'</span>');
 c.push('<span class="chip'+(liveGames().length?' g':'')+'">Games: '+(GAMES.length?liveGames().length+' live · '+upGames().length+' upcoming':'none loaded')+'</span>');c.push('<span class="chip">Lines: '+(LINES.length?LINES.length+' feed':'manual')+'</span>');c.push('<span class="chip">Opened '+ftime()+'</span>');$('chips').innerHTML=c.join('')}
function nav(){var h=TABS.map(function(t){return '<button data-t="'+t[0]+'" class="'+(tab===t[0]?'on':'')+'"><i>'+t[1]+'</i>'+t[2]+'</button>'}).join('');$('navBot').innerHTML=h;$('navTop').innerHTML=TABS.map(function(t){return '<button data-t="'+t[0]+'" class="'+(tab===t[0]?'on':'')+'">'+t[2]+'</button>'}).join('')}
function roster(team){var k=norm(team);return DB.filter(function(p){return norm(p.team)===k}).map(function(p){return p.name})}
function gameCard(g,full){var a=roster(g.team1),b=roster(g.team2);return '<div class="card"><div class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+(g.bo?' · Bo'+esc(g.bo):'')+'</div><div class="big">'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</div>'+
 (full?'<div class="muted">'+esc(g.team1)+(rankOf(g.team1)?' #'+rankOf(g.team1):'')+': '+(a.join(', ')||'no roster data')+'</div><div class="muted">'+esc(g.team2)+(rankOf(g.team2)?' #'+rankOf(g.team2):'')+': '+(b.join(', ')||'no roster data')+'</div>':'')+'<div class="btns"><button class="g" data-act="gamegrade" data-i="'+g.id+'">See props</button></div></div>'}
function recents(){return load('gp_recent',[])}
function viewDash(){var ls=allLines().filter(function(l){return l.g}).sort(function(a,b){return Math.abs(b.g.edge/b.line)-Math.abs(a.g.edge/a.line)}).slice(0,5),rc=recents(),dg=liveGames().concat(upGames());
 var h='<div class="card"><h2>Player search</h2><div class="row"><input id="ds" list="plist" placeholder="Search a player, e.g. donk"><button class="b" style="flex:0 0 auto;margin:0" data-act="dsearch">Stats</button></div>'+(rc.length?'<div class="btns" style="margin-top:6px"><span class="muted" style="align-self:center">Recent:</span>'+rc.map(function(n){return '<button class="g" data-act="plview" data-p="'+esc(n)+'">'+esc(n)+'</button>'}).join('')+'<button class="g" data-act="rclear">Clear</button></div>':'')+'</div>';
 h+='<div class="grid c2"><div class="card"><h2>Live + upcoming games · '+dg.length+'</h2>'+(dg.length?'<div class="scroll" style="max-height:560px;overflow-y:auto">'+dg.map(function(g){return '<div class="item"><div><b>'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</b>'+(g.status==='live'?' <span class="pill">LIVE</span>':'')+'<br><span class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+'</span></div><button class="g" style="margin:0" data-act="gameopen">Rosters</button></div>'}).join('')+'</div>':'<div class="warn">No schedule loaded yet. Run the "Update CS2 games" workflow.</div>')+'</div>';
 h+='<div><div class="card"><h2>Top graded lines</h2>'+(ls.length?ls.map(function(l){return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(l.team)+'</span><br><span class="muted">'+sname(l.stat)+' · line '+l.line+' · proj '+l.g.proj+'</span></div><div><span class="pill '+(l.g.pick==='UNDER'?'u':'')+'">'+l.g.grade+' '+l.g.pick+'</span></div></div>'}).join(''):'<div class="warn">No lines yet. Add a PrizePicks line in the Lines tab.</div>')+'</div>';
 h+='<div class="card"><h2>Quick actions</h2><div class="btns"><button class="b" data-act="go" data-t="grader">Grade a prop</button><button class="g" data-act="go" data-t="lines">Lines</button><button class="g" data-act="go" data-t="slip">Slip ('+slip.length+')</button><button class="g" data-act="reload">Reload data</button></div></div></div></div>';return h+recordCard()+opts()}
function liveCard(g){var sc=(g.s1!=null&&g.s2!=null)?' <span style="color:var(--green);margin-left:8px">'+g.s1+' – '+g.s2+'</span>':'';
 var ws=(g.streams||[]).filter(function(u){return /^https:\/\//.test(u)});
 var w=ws.map(function(u,k){return '<a href="'+esc(u)+'" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;padding:9px 12px;border:1px solid var(--green);border-radius:10px;color:var(--green);font-weight:700;text-decoration:none">Watch'+(ws.length>1?' '+(k+1):'')+'</a>'}).join('');
 return '<div class="card"><div class="muted"><span class="pill">LIVE</span> '+esc(g.tournament||'')+' · started '+esc(ftime(g.start))+(g.bo?' · Bo'+esc(g.bo):'')+'</div><div class="big">'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+sc+'</div><div class="btns"><button class="g" data-act="gamegrade">See props</button>'+w+'</div></div>'}
function viewGames(){if(!GAMES.length)return '<div class="card"><h2>Games</h2><div class="warn">No schedule loaded yet. Run the "Update CS2 games" workflow once to create games.json.</div></div>';
 var lv=liveGames(),up=upGames(),v=sel.gv||(lv.length?'live':'up'),age=gamesAge();
 var h='<div class="btns" style="margin-bottom:10px"><button class="'+(v==='live'?'b':'g')+'" data-act="gsub" data-v="live">Live · '+lv.length+'</button><button class="'+(v==='up'?'b':'g')+'" data-act="gsub" data-v="up">Upcoming · '+up.length+'</button></div>';
 h+='<div class="muted" style="margin-bottom:8px">From bo3.gg, updated '+esc(META.games_at||'')+(age!=null?' ('+Math.round(age)+' min ago)':'')+'. Times are Central. Refreshes about every 10 minutes.</div>';
 if(age!=null&&age>90)h+='<div class="warn">This game data is '+(Math.round(age/6)/10)+' hours old, so live status may be out of date.</div>';
 if(v==='live'){
  if(!lv.length)return h+'<div class="card"><h2>Live</h2><div class="muted">No matches are live right now. A match shows here only while bo3.gg marks it live, and drops off when it finishes.</div></div>';
  return h+'<div class="grid c2">'+lv.map(liveCard).join('')+'</div><div class="muted" style="margin-top:8px">Watch buttons appear only when bo3.gg gives an official stream link for the match.</div>'}
 if(!up.length)return h+'<div class="card"><h2>Upcoming</h2><div class="muted">No upcoming matches in the schedule.</div></div>';
 var days={};up.forEach(function(g){var d=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'long',month:'short',day:'numeric'}).format(new Date(g.start));(days[d]=days[d]||[]).push(g)});
 return h+Object.keys(days).map(function(d){return '<h2>'+esc(d)+' · '+days[d].length+' games</h2><div class="grid c2">'+days[d].map(function(g){return gameCard(g,true)}).join('')+'</div>'}).join('')}
function lineDays(ls){var t=cday(),set={};set[t]=1;set[addDays(t,1)]=1;ls.forEach(function(l){if(l.start)set[cday(l.start)]=1});return Object.keys(set).sort().filter(function(d){return d>=t})}
function viewLines(){var ls=allLines(),days=lineDays(ls),cnt={},t0=cday();
 ls.forEach(function(l){var k=l.start?cday(l.start):t0;cnt[k]=(cnt[k]||0)+1});
 var d=sel.ld;if(!d||(d!=='all'&&days.indexOf(d)<0))d=cnt[t0]?t0:(days.filter(function(x){return cnt[x]})[0]||'all');
 var h='<div class="btns" style="margin-bottom:8px">'+days.map(function(x){return '<button class="'+(d===x?'b':'g')+'" data-act="lday" data-d="'+x+'">'+esc(dayLabel(x))+' · '+(cnt[x]||0)+'</button>'}).join('')+'<button class="'+(d==='all'?'b':'g')+'" data-act="lday" data-d="all">All · '+ls.length+'</button></div>';
 var vis=[];ls.forEach(function(l,i){var k=l.start?cday(l.start):t0;if(d==='all'||k===d)vis.push([l,i])});
 vis.sort(function(a,b){var x=a[0].start||'9',y=b[0].start||'9';if(x!==y)return x<y?-1:1;var ea=a[0].g?Math.abs(a[0].g.edge/a[0].line):0,eb=b[0].g?Math.abs(b[0].g.edge/b[0].line):0;return eb-ea});
 h+='<div class="grid c2"><div class="card"><h2>'+(d==='all'?'All lines':esc(dayLabel(d))+' lines')+' · PrizePicks + Underdog · Maps 1-2</h2>'+(LINES.length?'<div class="muted">Feed observed '+esc(META.lines_at||'')+'. Refreshes about every hour. Times are Central.</div>':'<div class="warn">No lines feed is connected yet, so lines are manual. PrizePicks is the source of truth: type the line you see in the app.</div>')+
 (vis.length?vis.map(function(a){var l=a[0],i=a[1],g=l.g,live=l.team&&liveFor(l.team),started=l.start&&new Date(l.start).getTime()<NOW();return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(l.team)+(l.opp?' vs '+esc(l.opp):'')+'</span>'+(live?' <span class="pill">LIVE</span>':(started?' <span class="muted">· started</span>':''))+'<br><span class="muted">'+(l.book?esc(l.book)+' · ':'')+sname(l.stat)+(l.start?' · '+esc(fmt(l.start)):'')+' · </span><b>'+l.line+'</b>'+(g?'<span class="muted"> · proj '+g.proj+' · over '+g.over+'/'+g.of+'</span>':'<span class="muted"> · no stats for '+(l.miss?esc(l.miss):'this player')+'</span>')+'</div><div style="text-align:right">'+(g?'<span class="pill '+(g.pick==='UNDER'?'u':'')+'">'+g.grade+' '+g.pick+'</span><br>':'')+'<button class="g" data-act="lg" data-i="'+i+'">Grade</button> <button class="g" data-act="ladd" data-i="'+i+'">+ Slip</button>'+(l.src==='manual'?' <button class="g" data-act="ldel" data-i="'+l.idx+'">✕</button>':'')+'</div></div>'}).join(''):'<div class="muted">No lines for this day yet. New lines appear as the books post them.</div>')+'</div>';
 h+='<div class="card"><h2>Add / edit a line</h2><label>Player</label><input id="mp" list="plist" placeholder="Start typing a player"><label>Stat</label><select id="ms"><option value="kills">Kills Maps 1-2</option><option value="hs">Headshots Maps 1-2</option></select><label>Opponent (optional)</label><input id="mo" list="tlist" placeholder="Team name"><label>Line</label><input id="ml" type="number" step="0.5" placeholder="e.g. 34.5"><button class="b" data-act="madd">Save line</button></div></div>';return h}
// ---- track record: every saved line is graded with stats from BEFORE its match date, then checked against the real result
function recordData(){var rows=[],pending=0,nodata=0,seen={};
 (HIST||[]).forEach(function(e){var st=normStat(e.stat);if(!st||!e.start)return;var t=new Date(e.start).getTime();if(isNaN(t))return;
  if(t>NOW()-5*3600000){pending++;return}
  if(isCombo(e.player)){ // combo: needs the locked pick, and every player's result for that match added up
   if(!(e.lock&&e.lock.grade)){nodata++;return}
   var d1=cday(e.start),k1=norm(e.player)+st+d1;if(seen[k1])return;var tot=0,okc=true;
   e.player.split('+').forEach(function(n){var pc=find(n.trim(),e.team),bc=null;if(!pc){okc=false;return}
    combos(pc).forEach(function(c){if(!c.date||!teq(c.opp,e.opponent))return;var dd=Math.abs((new Date(c.date+'T12:00:00Z')-new Date(d1+'T12:00:00Z'))/864e5);if(dd<=1&&(!bc||dd<bc.dd))bc={c:c,dd:dd}});
    if(!bc||bc.c[st]==null)okc=false;else tot+=bc.c[st]});
   if(!okc){nodata++;return}
   var lc=+e.lock.line;if(tot===lc)return;seen[k1]=1;
   rows.push({player:e.player,stat:st,line:lc,act:tot,pick:e.lock.pick,grade:e.lock.grade,proj:e.lock.proj,locked:true,hit:e.lock.pick==='OVER'?tot>lc:tot<lc,start:e.start});return}
  var p=find(e.player,e.team);if(!p){nodata++;return}
  var d0=cday(e.start),key=norm(e.player)+st+d0;if(seen[key])return;
  var best=null;combos(p).forEach(function(c){if(!c.date||!teq(c.opp,e.opponent))return;var dd=Math.abs((new Date(c.date+'T12:00:00Z')-new Date(d0+'T12:00:00Z'))/864e5);if(dd<=1&&(!best||dd<best.dd))best={c:c,dd:dd}});
  if(!best||best.c[st]==null){nodata++;return}
  var past={name:p.name,team:p.team,logs:(p.logs||[]).filter(function(l){return l.date&&l.date<best.c.date})};
  var lk=e.lock&&e.lock.grade?e.lock:null; // locked in when the line was first seen: the exact grade, projection and pick the app gave then
  var line=lk?+lk.line:+e.line,g=lk?{grade:lk.grade,proj:lk.proj,pick:lk.pick}:grade(past,st,line,e.opponent);if(!g){nodata++;return}
  var act=best.c[st];if(act===line)return;seen[key]=1;
  var pick=lk?lk.pick:((g.grade==='D'||g.grade==='F')?'UNDER':'OVER');
  rows.push({player:e.player,stat:st,line:line,act:act,pick:pick,grade:g.grade,proj:g.proj,locked:!!lk,hit:pick==='OVER'?act>line:act<line,start:e.start})});
 rows.sort(function(a,b){return a.start<b.start?1:-1});return{rows:rows,pending:pending,nodata:nodata,total:(HIST||[]).length}}
function recordCard(){var h='<div class="card" style="margin-top:12px"><h2>Track record</h2>';
 if(HIST==null)return h+'<div class="warn">No line history yet. It starts saving after the next "Update CS2 lines" run with the new script.</div></div>';
 var R=recordData(),rows=R.rows;
 if(!rows.length)return h+'<div class="muted">'+R.total+' lines saved so far. '+R.pending+' waiting for their matches to finish, '+R.nodata+' finished but not matched to results yet (player stats refresh once a day). The record fills in by itself.</div></div>';
 var hits=rows.filter(function(r){return r.hit}).length,err=rows.map(function(r){return r.proj-r.act});
 h+='<div class="stats"><div class="st"><b>'+hits+'-'+(rows.length-hits)+'</b><span>Record ('+Math.round(hits/rows.length*100)+'%)</span></div><div class="st"><b>'+rows.length+'</b><span>Graded picks</span></div><div class="st"><b>'+fv(mean(err.map(Math.abs)))+'</b><span>Avg miss (kills/HS)</span></div><div class="st"><b>'+(mean(err)>=0?'+':'')+fv(mean(err))+'</b><span>Projection bias</span></div></div>';
 h+='<div class="scroll"><table><tr><th>Grade</th><th>Picks</th><th>Hit rate</th></tr>'+['A+','B','C','D','F'].map(function(G){var r=rows.filter(function(x){return x.grade===G}),hh=r.filter(function(x){return x.hit}).length;return '<tr><td>'+G+'</td><td>'+r.length+'</td><td>'+(r.length?Math.round(hh/r.length*100)+'% ('+hh+'-'+(r.length-hh)+')':'–')+'</td></tr>'}).join('')+'</table></div>';
 h+='<h2 style="margin-top:12px">Latest results</h2>'+rows.slice(0,15).map(function(r){return '<div class="item"><div><b>'+esc(r.player)+'</b> <span class="muted">'+sname(r.stat)+' · '+r.pick+' '+r.line+' · got '+r.act+' · proj '+r.proj+(r.locked?' · locked':'')+'</span></div><div><span class="pill '+(r.hit?'':'u')+'">'+(r.hit?'HIT':'MISS')+' · '+r.grade+'</span></div></div>'}).join('');
 return h+'<div class="muted" style="margin-top:8px">'+rows.filter(function(r){return r.locked}).length+' of '+rows.length+' picks are locked in: the exact line, grade, projection and pick the app gave when the line first appeared. Older ones were re-graded afterwards with stats from before their match. Pushes are skipped. '+R.pending+' pending, '+R.nodata+' not matched yet. Small samples mean little: wait for a few hundred picks before changing any weights.</div></div>'}
function opts(){var t={};DB.forEach(function(p){t[p.team]=1});return '<datalist id="plist">'+DB.map(function(p){return '<option value="'+esc(p.name)+'">'+esc(p.team)}).join('')+'</datalist><datalist id="tlist">'+Object.keys(t).sort().map(function(x){return '<option value="'+esc(x)+'">'}).join('')+'</datalist>'}
function viewGrader(){var combo=isCombo(sel.player),p=combo?{name:sel.player}:find(sel.player,sel.team),line=parseFloat(sel.line),g=p&&!isNaN(line)?gradeFor(sel.player,sel.team||'',sel.stat,line,sel.opp):null,miss='';if(g&&g.missing){miss=g.missing;g=null}
 var h='<div class="grid c2"><div class="card"><h2>Prop grader</h2><label>Player</label><input id="gp" list="plist" value="'+esc(sel.player)+'" placeholder="Start typing a player"><div class="row"><div><label>Stat</label><select id="gs"><option value="kills"'+(sel.stat==='kills'?' selected':'')+'>Kills Maps 1-2</option><option value="hs"'+(sel.stat==='hs'?' selected':'')+'>Headshots Maps 1-2</option></select></div><div><label>Line</label><input id="gl" type="number" step="0.5" value="'+esc(sel.line)+'"></div></div><label>Opponent</label><input id="go" list="tlist" value="'+esc(sel.opp)+'" placeholder="Team name"><div class="btns"><button class="b" data-act="grade">Grade it</button></div></div>';
 if(!sel.player)h+='<div class="card"><div class="warn">Pick a player and a line to grade.</div></div>';
 else if(!p)h+='<div class="card"><div class="warn">No player named "'+esc(sel.player)+'" in the data.</div></div>';
 else if(!g&&miss)h+='<div class="card"><div class="warn">Cannot grade this combo: no usable Maps 1-2 stats for '+esc(miss)+'. Every player in a combo needs stats.</div></div>';
 else if(!g)h+='<div class="card"><div class="warn">Not enough Maps 1-2 data for '+esc(p.name)+' yet (needs matches where both Map 1 and Map 2 were played) or the line is empty.</div></div>';
 else h+=gradeCard(g);return h+'</div>'+opts()}
// ---- bar chart: real number on every bar, dashed line = the prop line, green over / red under
function chart(cs,st,line){var rows=cs.slice(0,10).filter(function(c){return c[st]!=null}).reverse();if(!rows.length)return '<div class="muted">No '+(st==='hs'?'headshot':'kill')+' data for this selection.</div>';
 var hasL=line!=null&&!isNaN(line),mx=Math.max.apply(null,rows.map(function(c){return c[st]}).concat([hasL?line:0,1]))*1.25;
 var cols=rows.map(function(c){var x=c[st],col=!hasL?'var(--green)':x>line?'var(--green)':x<line?'var(--red)':'#777';return '<div class="bc"><div class="bn">'+x+'</div><div class="bar" style="height:'+(x/mx*100)+'%;background:'+col+'"></div></div>'}).join('');
 var ds=rows.map(function(c){return '<div class="bd">'+esc(String(c.date||'').slice(5))+'</div>'}).join('');
 return '<div class="bars">'+(hasL?'<div class="ln" style="bottom:'+(line/mx*100)+'%"><span>'+line+'</span></div>':'')+cols+'</div><div class="bdates">'+ds+'</div>'}
function gradeCard(g){return '<div class="card"><div class="muted">'+esc(g.player)+' · '+esc(g.team)+(g.opp?' vs '+esc(g.opp):'')+' · '+sname(g.stat)+' · line '+g.line+'</div><div class="grade'+gclass(g.grade)+'">'+g.grade+'</div><div><span class="pill '+(g.pick==='UNDER'?'u':'')+'">'+esc(g.label)+'</span></div>'+
 '<div class="stats"><div class="st"><b>'+g.proj+'</b><span>Projection</span></div><div class="st"><b>'+(g.edge>=0?'+':'')+g.edge+'</b><span>Edge vs line</span></div><div class="st"><b>'+g.over+'/'+g.of+'</b><span>Over, last '+g.of+'</span></div></div>'+
 '<h2 style="margin-top:12px">Last 10 '+(g.stat==='hs'?'headshots':'kills')+' (Maps 1-2)</h2>'+chart(g.cs,g.stat,g.line)+'<div class="muted">Oldest to newest, with the date under each bar. Dashed line = '+g.line+'. Green = over, red = under.</div>'+
 '<h2 style="margin-top:12px">Breakdown</h2><div class="scroll"><table><tr><th>Part</th><th>Weight</th><th>Avg</th><th>Sample</th></tr>'+g.comp.map(function(c){return '<tr><td>'+esc(c.k)+'</td><td>'+(c.w==null?'sum':Math.round(c.w*100)+'%')+'</td><td>'+(c.v==null?'no data':c.v.toFixed(1))+'</td><td>'+c.n+'</td></tr>'}).join('')+'</table></div>'+
 '<div class="muted" style="margin-top:6px">'+esc(g.adj)+'. Parts with no data are left out and the other weights are scaled up. Blowout and role are not in the data.</div>'+
 '<div class="btns"><button class="b" data-act="gadd">Add to slip</button><button class="g" data-act="gimg">Download image</button><button class="g" data-act="gshare">Share</button></div>'+
 '<h2 style="margin-top:12px">Last 10 (Maps 1-2)</h2><div class="scroll"><table><tr><th>Date</th><th>Opp</th><th>Maps</th><th>'+(g.stat==='hs'?'HS':'Kills')+'</th></tr>'+g.cs.slice(0,10).map(function(c){return '<tr><td>'+esc(c.date)+'</td><td>'+esc(c.opp)+'</td><td>'+esc(c.maps)+'</td><td>'+(c[g.stat]==null?'':c[g.stat])+'</td></tr>'}).join('')+'</table></div></div>'}
// ---- auto slips: strong overs and strong unders, mixed
function buildSlip(n,mode){
 var best={};allLines().forEach(function(l){if(!l.g||!l.line||isCombo(l.player))return;var k=norm(l.player),e=Math.abs(l.g.edge/l.line);if(!best[k]||e>best[k].e)best[k]={l:l,e:e}});
 var all=Object.keys(best).map(function(k){var l=best[k].l;return{l:l,pct:l.g.edge/l.line}});
 var ov=all.filter(function(x){return (x.l.g.grade==='A+'||x.l.g.grade==='B')&&x.pct>0}).sort(function(a,b){return b.pct-a.pct});
 var un=all.filter(function(x){return (x.l.g.grade==='D'||x.l.g.grade==='F')&&x.pct<=-.05}).sort(function(a,b){return a.pct-b.pct});
 var used={},out=[];
 function take(arr,cnt){var t=0;for(var i=0;i<arr.length&&t<cnt;i++){var k=norm(arr[i].l.player);if(used[k])continue;used[k]=1;out.push(arr[i]);t++}return t}
 var both=ov.concat(un).sort(function(a,b){return Math.abs(b.pct)-Math.abs(a.pct)});
 if(mode==='safe'){take(both,n)}
 else if(mode==='deg'){ // biggest edges overall, but force at least one of each side when both exist
  if(ov.length&&un.length){var bo=ov[0],bu=un[0];used[norm(bo.l.player)]=1;used[norm(bu.l.player)]=1;out.push(bo,bu)}
  take(both,n-out.length)}
 else{ // balanced: 2 of the side with the bigger top edge + the rest from the other (3 legs), or 2 and 2 (4 legs)
  var a1=ov,a2=un,n1=Math.ceil(n/2),n2=n-n1;
  if(un.length&&(!ov.length||Math.abs(un[0].pct)>ov[0].pct)){a1=un;a2=ov}
  take(a1,n1);take(a2,n2)}
 var short=n-out.length;
 if(short>0)take(both,short);
 if(out.length<n){ // still short: use the best remaining graded lines, any grade
  take(all.slice().sort(function(a,b){return Math.abs(b.pct)-Math.abs(a.pct)}),n-out.length)}
 var res=out.map(function(x){return{player:x.l.player,stat:x.l.stat,line:x.l.line,pick:x.l.g.pick,grade:x.l.g.grade}});
 var no=res.filter(function(x){return x.pick==='OVER'}).length,nu=res.length-no,weak=out.filter(function(x){return !((x.l.g.grade==='A+'||x.l.g.grade==='B')&&x.pct>0)&&!((x.l.g.grade==='D'||x.l.g.grade==='F')&&x.pct<=-.05)}).length;
 var msg='Built '+res.length+'-leg slip: '+no+' Over'+(no===1?'':'s')+', '+nu+' Under'+(nu===1?'':'s')+(res.length<n?' (only '+res.length+' lines available)':'');
 if(res.length&&(!(no&&nu)||weak)&&mode!=='safe')msg+=weak?'. Not enough strong picks, so '+weak+' weaker leg'+(weak===1?' was':'s were')+' added':'. Only one side had strong picks';
 return{out:res,msg:msg}}
function viewSlip(){var h='<div class="grid c2"><div class="card"><h2>Slip builder</h2><div class="btns"><button class="g" data-act="auto" data-n="2" data-m="safe">Safe 2-Leg</button><button class="g" data-act="auto" data-n="3" data-m="bal">Balanced 3-Leg</button><button class="g" data-act="auto" data-n="4" data-m="bal">Balanced 4-Leg</button><button class="g" data-act="auto" data-n="4" data-m="deg">Degenerate 4-Leg</button></div><div class="muted" style="margin-top:6px">Auto slips mix strong Overs (grade A+ or B) with strong Unders (D or F, projection at least 5% below the line), one leg per player. Safe 2-Leg takes the two biggest edges on either side. Balanced 3-Leg is 2 of one side and 1 of the other. Balanced 4-Leg is 2 Overs and 2 Unders. Degenerate 4-Leg takes the four biggest edges with at least one of each side. If a side runs short, the slip fills from the other side and says so.</div></div>';
 h+='<div class="card"><h2>Your slip · '+slip.length+' legs</h2>'+(slip.length?slip.map(function(s,i){return '<div class="item"><div><b>'+esc(s.player)+'</b> <span class="pill '+(s.pick==='UNDER'?'u':'')+'">'+s.pick+' '+s.line+'</span><br><span class="muted">'+sname(s.stat)+(s.grade?' · grade '+esc(s.grade):'')+'</span></div><button class="g" data-act="sdel" data-i="'+i+'">✕</button></div>'}).join('')+'<div class="btns"><button class="b" data-act="scopy">Copy</button><button class="g" data-act="spp">Open PrizePicks</button><button class="g" data-act="simg">Download image</button><button class="g" data-act="sshare">Share</button><button class="g" data-act="sclear">Clear</button></div>':'<div class="muted">Empty. Add legs from Lines or Grader.</div>')+'</div></div>';return h}
function fv(x,d){return x==null||isNaN(x)?'–':x.toFixed(d==null?1:d)}
function pct(a,b){return b?(a/b*100):null}
function summ(cs){var n=cs.length,o={n:n,maps:n*2},kk=cs.reduce(function(a,c){return a+c.kills},0);o.kpm=n?kk/(2*n):null;
 var h=cs.filter(function(c){return c.hs!=null});o.hsp=pct(h.reduce(function(a,c){return a+c.hs},0),h.reduce(function(a,c){return a+c.kills},0));
 var d=cs.filter(function(c){return c.deaths!=null});o.kd=d.length?d.reduce(function(a,c){return a+c.kills},0)/(d.reduce(function(a,c){return a+c.deaths},0)||1):null;
 var a=cs.filter(function(c){return c.assists!=null});o.apm=a.length?a.reduce(function(x,c){return x+c.assists},0)/(2*a.length):null;
 o.adr=mean(cs.map(function(c){return c.adr}).filter(function(x){return x!=null}));o.kills=mean(cs.map(function(c){return c.kills}));o.hs=mean(nums(cs,'hs'));
 o.x={};cs.forEach(function(c){for(var k in c.x)(o.x[k]=o.x[k]||[]).push(c.x[k])});for(var k in o.x)o.x[k]=mean(o.x[k])/2;return o}
function pcard(){var p=find(sel.pl);if(!p)return '<div class="card"><div class="warn">No player named "'+esc(sel.pl)+'".</div></div>';
 var all=combos(p),v=sel.v||'all',n=sel.n||'10',o=sel.o||'',l1=parseFloat(sel.l1),l2=parseFloat(sel.l2);
 var hasEv=all.some(function(c){return c.ev});
 var base=all.filter(function(c){return v==='all'||c.ev===v});
 var opps={};all.forEach(function(c){if(c.opp)opps[c.opp]=1});
 var f=base.filter(function(c){return !o||norm(c.opp)===norm(o)});var cs=n==='all'?f:f.slice(0,+n);var S=summ(cs);
 var h='<div class="card"><h2>'+esc(p.name)+' · '+esc(p.team)+(rankOf(p.team)?' · #'+rankOf(p.team):'')+'</h2>';
 h+='<div class="row"><div><label>Sample</label><select id="pn">'+['5','10','15','all'].map(function(x){return '<option value="'+x+'"'+(x===n?' selected':'')+'>'+(x==='all'?'All logged':'Last '+x)+'</option>'}).join('')+'</select></div><div><label>Venue</label><select id="pv"><option value="all"'+(v==='all'?' selected':'')+'>All events</option><option value="lan"'+(v==='lan'?' selected':'')+'>LAN only</option><option value="online"'+(v==='online'?' selected':'')+'>Online only</option></select></div></div>';
 h+='<div class="row"><div><label>Opponent</label><select id="po"><option value="">Every team</option>'+Object.keys(opps).sort().map(function(t){return '<option'+(t===o?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div><div><label>Kills line</label><input id="pl1" type="number" step="0.5" value="'+esc(sel.l1||'')+'" placeholder="Maps 1-2"></div><div><label>HS line</label><input id="pl2" type="number" step="0.5" value="'+esc(sel.l2||'')+'" placeholder="Maps 1-2"></div></div>';
 if(!hasEv)h+='<div class="warn">LAN / online labels are not in the data yet. Run the "Update CS2 data" workflow with the new script and they will appear.</div>';
 if(!S.n){h+='<div class="warn">No matches with both Map 1 and Map 2 for this selection.</div></div>';return h}
 if(S.n<3)h+='<div class="warn">Small sample: only '+S.n+' series. Read the numbers with care.</div>';
 var ov=function(st,ln){if(isNaN(ln))return '';var vv=nums(cs,st);var c=vv.filter(function(x){return x>ln}).length;return '<div class="st"><b>'+c+'/'+vv.length+'</b><span>Over '+ln+' ('+Math.round(c/Math.max(vv.length,1)*100)+'%)</span></div>'};
 h+='<div class="stats"><div class="st"><b>'+S.n+'</b><span>Series ('+S.maps+' maps)</span></div><div class="st"><b>'+fv(S.kills)+'</b><span>Kills M1-2</span></div><div class="st"><b>'+fv(S.hs)+'</b><span>HS M1-2</span></div><div class="st"><b>'+fv(S.kpm)+'</b><span>Kills / map</span></div><div class="st"><b>'+fv(S.hsp,0)+'%</b><span>Headshot %</span></div><div class="st"><b>'+fv(S.kd,2)+'</b><span>K/D</span></div><div class="st"><b>'+fv(S.apm)+'</b><span>Assists / map</span></div><div class="st"><b>'+fv(S.adr,0)+'</b><span>ADR</span></div>'+ov('kills',l1)+ov('hs',l2)+'</div>';
 var xs=Object.keys(S.x);if(xs.length)h+='<div class="stats">'+xs.map(function(k){return '<div class="st"><b>'+fv(S.x[k],2)+'</b><span>'+esc(k.replace(/_/g,' '))+' / map</span></div>'}).join('')+'</div>';
 else h+='<div class="muted">Clutches, first kills and shot accuracy appear here once bo3.gg returns them in the per-map rows. Check the Actions log line "players_stats keys".</div>';
 h+='<h2 style="margin-top:12px">Last 10 kills (Maps 1-2)</h2>'+chart(cs,'kills',l1)+'<h2 style="margin-top:12px">Last 10 headshots (Maps 1-2)</h2>'+chart(cs,'hs',l2)+'<div class="muted">Follows the venue and opponent filters above. Type a kills or HS line to draw the dashed line and color the bars.</div>';
 h+='<h2 style="margin-top:12px">Series (Maps 1-2)</h2><div class="scroll"><table><tr><th>Date</th><th>Opp</th><th>Event</th><th>Maps</th><th>K</th><th>HS</th><th>D</th><th>A</th><th>ADR</th></tr>'+cs.map(function(c){return '<tr><td>'+esc(c.date)+'</td><td>'+esc(c.opp)+'</td><td>'+(c.ev?c.ev.toUpperCase():'–')+'</td><td>'+esc(c.maps)+'</td><td>'+c.kills+'</td><td>'+(c.hs==null?'–':c.hs)+'</td><td>'+(c.deaths==null?'–':c.deaths)+'</td><td>'+(c.assists==null?'–':c.assists)+'</td><td>'+fv(c.adr,0)+'</td></tr>'}).join('')+'</table></div>';
 // per-opponent breakdown (venue filter applies, sample size does not)
 var by={};base.forEach(function(c){(by[c.opp||'?']=by[c.opp||'?']||[]).push(c)});
 var rows=Object.keys(by).map(function(t){return{t:t,s:summ(by[t]),cs:by[t]}}).sort(function(a,b){return b.s.n-a.s.n||a.t.localeCompare(b.t)});
 h+='<h2 style="margin-top:14px">'+(v==='lan'?'LAN':v==='online'?'Online':'All events')+' vs every team · Maps 1-2</h2><div class="scroll"><table><tr><th>Opponent</th><th>Series</th><th>Kills</th><th>HS</th><th>HS%</th><th>K/D</th><th>ADR</th><th>Kills over</th><th>HS over</th></tr>'+rows.map(function(r){var k=nums(r.cs,'kills'),hh=nums(r.cs,'hs');return '<tr><td>'+esc(r.t)+'</td><td>'+r.s.n+(r.s.n<3?' ⚠':'')+'</td><td>'+fv(r.s.kills)+'</td><td>'+fv(r.s.hs)+'</td><td>'+fv(r.s.hsp,0)+'</td><td>'+fv(r.s.kd,2)+'</td><td>'+fv(r.s.adr,0)+'</td><td>'+(isNaN(l1)?'–':k.filter(function(x){return x>l1}).length+'/'+k.length)+'</td><td>'+(isNaN(l2)||!hh.length?'–':hh.filter(function(x){return x>l2}).length+'/'+hh.length)+'</td></tr>'}).join('')+'</table></div><div class="muted">⚠ = fewer than 3 series. Set the kills and HS lines above to fill the over columns.</div>';
 h+='<div class="btns"><button class="b" data-act="pgrade">Grade a line</button><button class="g" data-act="pclose">Back to list</button></div></div>';return h}
function viewPlayers(){if(sel.pl)return pcard()+opts();var q=(sel.q||'').toLowerCase(),tm=sel.tm||'';var teams={};DB.forEach(function(p){teams[p.team]=1});
 var list=DB.filter(function(p){return(!tm||p.team===tm)&&(p.name+p.team).toLowerCase().indexOf(q)>-1}).slice(0,200);
 return '<div class="card"><h2>Players · '+DB.length+' active</h2><div class="row"><input id="pq" placeholder="Search players or teams" value="'+esc(sel.q||'')+'"><select id="pt"><option value="">All teams</option>'+Object.keys(teams).sort().map(function(t){return '<option'+(t===tm?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div><div class="scroll"><table><tr><th>Player</th><th>Team</th><th>Kills M1-2</th><th>HS M1-2</th><th></th></tr>'+list.map(function(p){var cs=combos(p).slice(0,10);return '<tr><td>'+esc(p.name)+'</td><td>'+esc(p.team)+'</td><td>'+(cs.length?mean(nums(cs,'kills')).toFixed(1):'–')+'</td><td>'+(nums(cs,'hs').length?mean(nums(cs,'hs')).toFixed(1):'–')+'</td><td><button class="g" style="margin:0" data-act="plview" data-p="'+esc(p.name)+'">Stats</button></td></tr>'}).join('')+'</table></div><div class="muted">Averages are the last 10 series with both Map 1 and Map 2 played.</div></div>'}
function render(){nav();chips();var v={dash:viewDash,games:viewGames,lines:viewLines,grader:viewGrader,slip:viewSlip,players:viewPlayers}[tab]();$('main').innerHTML=v+(tab==='lines'?opts():'')}
function go(t){tab=t;render();window.scrollTo(0,0)}
// ---- images (grade + translucent logo only). Font: Russo One (bold, sporty), loaded from Google Fonts; falls back to Impact.
var IMGFONT='"Russo One",Impact,"Arial Black",sans-serif';
(function(){try{var l=document.createElement('link');l.rel='stylesheet';l.href='https://fonts.googleapis.com/css2?family=Russo+One&display=swap';document.head.appendChild(l)}catch(e){}})();
function fontReady(cb){var done=false;function go(){if(!done){done=true;cb()}}setTimeout(go,1500);try{document.fonts.load('60px "Russo One"').then(go,go)}catch(e){go()}}
function img(kind,cb){fontReady(function(){var c=document.createElement('canvas');c.width=1080;c.height=1350;var x=c.getContext('2d');x.fillStyle='#0a0a0a';x.fillRect(0,0,1080,1350);x.strokeStyle='#00FF66';x.lineWidth=10;x.strokeRect(24,24,1032,1302);
 var im=new Image();im.onload=function(){x.globalAlpha=.12;var w=760,h=w*im.height/im.width;x.drawImage(im,(1080-w)/2,(1350-h)/2,w,h);x.globalAlpha=1;draw();cb(c)};im.onerror=function(){draw();cb(c)};im.src='assets/logo.png';
 function T(t,y,size,color,glow,maxW){x.font=size+'px '+IMGFONT;while(maxW&&size>20&&x.measureText(t).width>maxW){size-=2;x.font=size+'px '+IMGFONT}
  x.shadowColor=glow||'transparent';x.shadowBlur=glow?28:0;x.fillStyle=color;x.fillText(t,540,y);x.shadowBlur=0}
 function draw(){x.textAlign='center';if(kind.g){var g=kind.g,gc=g.grade==='A+'||g.grade==='B'?'#00FF66':g.grade==='C'?'#ffc53d':'#ff4d6d';
  T(g.player.toUpperCase(),190,70,'#fff','#00FF66',960);T(sname(g.stat).toUpperCase(),262,44,'#00FF66',null,960);T('LINE '+g.line+'  ·  PROJ '+g.proj,335,48,'#fff',null,960);
  T(g.grade,640,320,gc,gc,900);T(g.label.toUpperCase(),770,64,gc,null,960);
  T('OVER '+g.over+'/'+g.of+' LAST '+g.of+(g.opp?'  ·  VS '+g.opp.toUpperCase():''),850,36,'#c8cdd2',null,960)}
  else{slip.slice(0,8).forEach(function(s,i){T(s.player.toUpperCase()+' '+sname(s.stat).toUpperCase(),220+i*120,40,'#fff',null,960);T(s.pick+' '+s.line+(s.grade?'  ·  '+s.grade:''),282+i*120,50,s.pick==='UNDER'?'#ff4d6d':'#00FF66','rgba(0,255,102,.5)',960)})}
  T('GLOCKYS PROP GRADER',1290,40,'#00FF66','#00FF66',960)}})}
function showImg(url,blob,name){var old=document.getElementById('imgov');if(old)old.remove();
 var ov=document.createElement('div');ov.id='imgov';ov.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;z-index:100;background:rgba(0,0,0,.96);overflow:auto;-webkit-overflow-scrolling:touch;padding:16px;text-align:center';
 var im=document.createElement('img');im.src=url;im.alt=name;im.style.cssText='display:block;margin:0 auto 12px;max-width:100%;max-height:68vh;border-radius:12px;-webkit-touch-callout:default;-webkit-user-select:auto;user-select:auto';
 var hint=document.createElement('div');hint.textContent='Press and hold the image, then tap Save to Photos';hint.style.cssText='color:#c8cdd2;font:600 14px system-ui;margin-bottom:12px';
 var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;justify-content:center;flex-wrap:wrap;padding-bottom:24px';
 function btn(t,green){var b=document.createElement('button');b.textContent=t;b.style.cssText='font:800 15px system-ui;padding:13px 22px;border-radius:12px;border:1px solid #00FF66;cursor:pointer;'+(green?'background:#00FF66;color:#000':'background:#111;color:#00FF66');return b}
 function close(){ov.remove();setTimeout(function(){URL.revokeObjectURL(url)},500)}
 var f=null;try{f=new File([blob],name,{type:'image/png'})}catch(e){}
 if(f&&navigator.canShare&&navigator.canShare({files:[f]})){var sb=btn('Share',true);sb.onclick=function(){navigator.share({files:[f]}).then(function(){toast('Shared')}).catch(function(){})};row.appendChild(sb)}
 var db=btn('Download',!row.children.length);db.onclick=function(){var a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();toast('If nothing saved, press and hold the image')};row.appendChild(db);
 var cb=btn('Close',false);cb.onclick=close;row.appendChild(cb);
 ov.appendChild(im);ov.appendChild(hint);ov.appendChild(row);document.body.appendChild(ov)}
function dl(c,name){c.toBlob(function(b){if(!b){toast('Could not build the image');return}showImg(URL.createObjectURL(b),b,name)},'image/png')}
function share(c,name){dl(c,name)}
function curGrade(){var g=gradeFor(sel.player,sel.team||'',sel.stat,parseFloat(sel.line),sel.opp);return g&&!g.missing?g:null}
function addSlip(g){if(slip.some(function(s){return norm(s.player)===norm(g.player)&&s.stat===g.stat})){toast('Already on slip');return}slip.push({player:g.player,stat:g.stat,line:g.line,pick:g.pick,grade:g.grade});save('gp_slip',slip);toast('Added '+g.player+' '+g.pick+' '+g.line)}
function openP(n){sel.pl=n;sel.v='all';sel.o='';var r=recents().filter(function(x){return x!==n});r.unshift(n);save('gp_recent',r.slice(0,8));tab='players';render();window.scrollTo(0,0);toast('Stats for '+n)}
// ---- actions
document.addEventListener('click',function(e){var b=e.target.closest('[data-act],[data-t]');if(!b)return;
 if(b.dataset.t&&!b.dataset.act){go(b.dataset.t);return}
 var a=b.dataset.act,i=+b.dataset.i;
 if(a==='go')go(b.dataset.t);
 else if(a==='reload'){toast('Reloading…');boot()}
 else if(a==='gsub'){sel.gv=b.dataset.v;render()}
 else if(a==='lday'){sel.ld=b.dataset.d;render()}
 else if(a==='gamegrade'){go('players');toast('Pick a player from the team to grade')}
 else if(a==='dsearch'){var nm=($('ds').value||'').trim(),pp=find(nm);if(!pp){toast('No player named "'+nm+'"');return}openP(pp.name)}
 else if(a==='plview'){openP(b.dataset.p)}
 else if(a==='rclear'){save('gp_recent',[]);render();toast('Search history cleared')}
 else if(a==='gameopen'){toast('Search a player to see his stats')}
 else if(a==='pclose'){sel.pl='';render();toast('Back to list')}
 else if(a==='pgrade'){var pp2=find(sel.pl);sel.player=pp2.name;sel.line=sel.stat==='hs'?(sel.l2||''):(sel.l1||'');sel.opp=sel.o||'';go('grader');toast('Loaded '+pp2.name+' in the grader')}
 else if(a==='pg'){sel.player=b.dataset.p;var p=find(sel.player);sel.opp='';go('grader');toast('Loaded '+sel.player+'. Enter a line')}
 else if(a==='grade'){var np=$('gp').value;if(np!==sel.player)sel.team='';sel.player=np;sel.stat=$('gs').value;sel.line=$('gl').value;sel.opp=$('go').value;render();toast('Graded')}
 else if(a==='gadd'){var g=curGrade();if(g)addSlip(g)}
 else if(a==='gimg'){var g2=curGrade();if(g2)img({g:g2},function(c){dl(c,'grade-1080x1350.png')})}
 else if(a==='gshare'){var g3=curGrade();if(g3)img({g:g3},function(c){share(c,'grade.png')})}
 else if(a==='madd'){var n=$('mp').value.trim(),l=parseFloat($('ml').value);if(!n||isNaN(l)){toast('Enter a player and a line');return}var p2=find(n);manual.push({player:p2?p2.name:n,team:p2?p2.team:'',stat:$('ms').value,line:l,opponent:$('mo').value,period:'Maps 1-2',src:'manual'});save('gp_manual',manual);render();toast('Line saved')}
 else if(a==='ldel'){manual.splice(i-LINES.length,1);save('gp_manual',manual);render();toast('Line removed')}
 else if(a==='lg'){var l2=allLines()[i];sel={player:l2.player,stat:l2.stat,line:String(l2.line),opp:l2.opp,team:l2.team};go('grader');toast('Loaded '+l2.player)}
 else if(a==='ladd'){var l3=allLines()[i];if(!l3.g){toast('No stats for '+l3.player);return}addSlip(l3.g);render()}
 else if(a==='auto'){var r=buildSlip(+b.dataset.n,b.dataset.m||'bal');if(!r.out.length){toast('No graded lines yet. Add lines first');return}slip=r.out;save('gp_slip',slip);render();toast(r.msg)}
 else if(a==='sdel'){slip.splice(i,1);save('gp_slip',slip);render();toast('Removed')}
 else if(a==='sclear'){slip=[];save('gp_slip',slip);render();toast('Slip cleared')}
 else if(a==='scopy'){var t=slip.map(function(s){return s.player+' '+sname(s.stat)+' '+s.pick+' '+s.line}).join('\n');(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){toast('Copied')}).catch(function(){toast('Copy not allowed here')})}
 else if(a==='spp'){window.open('https://app.prizepicks.com','_blank','noopener');toast('Opening PrizePicks. Enter your picks there')}
 else if(a==='simg'){if(!slip.length){toast('Slip is empty');return}img({},function(c){dl(c,'slip-1080x1350.png')})}
 else if(a==='sshare'){if(!slip.length){toast('Slip is empty');return}img({},function(c){share(c,'slip.png')})}
});
document.addEventListener('input',function(e){if(e.target.id==='pq'){sel.q=e.target.value;var pos=e.target.selectionStart;render();var n=$('pq');n.focus();n.setSelectionRange(pos,pos)}});
document.addEventListener('change',function(e){var i=e.target.id,m={pt:'tm',pn:'n',pv:'v',po:'o',pl1:'l1',pl2:'l2'};if(m[i]){sel[m[i]]=e.target.value;render();toast('Updated')}});
// ---- data
function getJSON(u){return fetch(u+'?'+Date.now()).then(function(r){if(!r.ok)throw 0;return r.json()})}
function applyFeeds(g,l,h){
 if(g){GAMES=(g.games||[]).filter(function(x){return x.start}).sort(function(a,b){return a.start<b.start?-1:1});META.games_iso=g.updated||'';META.games_at=(g.updated&&g.updated.indexOf('T')>-1)?fmt(g.updated):(g.updated||'')}
 if(l){LINES=l.lines||[];META.lines_at=l.observed_at?fmt(l.observed_at):''}
 if(h&&h.entries)HIST=h.entries}
function feeds(){return Promise.all([getJSON('games.json').catch(function(){return null}),getJSON('lines.json').catch(function(){return null}),getJSON('lines_history.json').catch(function(){return null})])}
function boot(){Promise.all([getJSON('players.json'),feeds()]).then(function(r){
 DB=r[0].players||[];RANK=r[0].ranks||{};META.updated=r[0].updated||'';applyFeeds(r[1][0],r[1][1],r[1][2]);render();
 }).catch(function(){$('main').innerHTML='<div class="card"><div class="warn">Could not load players.json. Open this from the hosted site.</div></div>';nav()})}
setInterval(function(){if(document.hidden||!DB.length)return;var ae=document.activeElement;if(ae&&/INPUT|SELECT|TEXTAREA/.test(ae.tagName))return;if(['games','lines','dash'].indexOf(tab)<0)return;
 feeds().then(function(r){applyFeeds(r[0],r[1],r[2]);if(!document.getElementById('imgov'))render()})},60000);
nav();boot();
})();
