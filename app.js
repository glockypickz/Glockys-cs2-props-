(function(){
'use strict';
var $=function(i){return document.getElementById(i)};
var DB=[],RANK={},GAMES=[],LINES=[],META={updated:'',lines_at:'',games_at:''};
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
function combos(p){var by={};(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&l.mid!=null){var g=by[l.mid]=by[l.mid]||{date:l.date,opp:l.opp,m:{},kills:0,hs:0,hsOk:true,d:0,dOk:true,a:0,aOk:true,adr:[],ev:{},x:{}};g.m[l.n]=l.map;g.kills+=Number(l.kills)||0;
 if(l.hs==null)g.hsOk=false;else g.hs+=Number(l.hs)||0;if(l.d==null)g.dOk=false;else g.d+=Number(l.d)||0;if(l.a==null)g.aOk=false;else g.a+=Number(l.a)||0;if(l.adr!=null)g.adr.push(Number(l.adr));if(l.ev)g.ev[l.ev]=1;
 if(l.x)for(var k in l.x){(g.x[k]=g.x[k]||[]).push(l.x[k])}}});
 return Object.keys(by).map(function(k){return by[k]}).filter(function(g){return g.m[1]&&g.m[2]}).map(function(g){var evs=Object.keys(g.ev),x={};for(var k in g.x)x[k]=g.x[k].reduce(function(a,b){return a+b},0);
  return{date:g.date,opp:g.opp,maps:g.m[1]+' + '+g.m[2],kills:g.kills,hs:g.hsOk?g.hs:null,deaths:g.dOk?g.d:null,assists:g.aOk?g.a:null,adr:g.adr.length?g.adr.reduce(function(a,b){return a+b},0)/g.adr.length:null,ev:evs.length===1?evs[0]:null,x:x}}).sort(function(a,b){return a.date<b.date?1:-1})}
function mean(a){return a.length?a.reduce(function(x,y){return x+y},0)/a.length:null}
function sd(a){var m=mean(a);return a.length?Math.sqrt(mean(a.map(function(x){return (x-m)*(x-m)}))):0}
function nums(cs,st){return cs.map(function(c){return c[st]}).filter(function(x){return x!=null})}
function tier(r){return r<=5?'Top 5':r<=15?'Top 6-15':r<=30?'Top 16-30':'Top 31+'}
function rankOf(name){var k=norm(name);for(var t in RANK)if(norm(t)===k)return RANK[t];return null}
function find(name){var k=norm(name);return DB.filter(function(p){return norm(p.name)===k})[0]}
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
function gclass(g){return g==='A+'||g==='B'?'':g==='C'?' mid':' low'}
function sname(s){return s==='hs'?'Headshots Maps 1-2':'Kills Maps 1-2'}
function normStat(s){s=String(s||'').toLowerCase();return s.indexOf('head')>-1||s==='hs'?'hs':s.indexOf('kill')>-1?'kills':null}
// ---- all lines = feed + manual
function allLines(){var out=[];LINES.concat(manual).forEach(function(l,i){var st=normStat(l.stat);if(!st)return;var per=String(l.period||'Maps 1-2');if(per.replace(/\s/g,'').toLowerCase().indexOf('maps1-2')<0&&per.indexOf('1-2')<0&&l.src!=='manual')return;
 var p=find(l.player);var o={player:l.player,team:l.team||(p&&p.team)||'',stat:st,line:+l.line,opp:l.opponent||'',src:l.src||'feed',idx:i,book:l.book||'',start:l.starts_at||''};o.g=p?grade(p,st,o.line,o.opp):null;out.push(o)});return out}
// ---- views
function chips(){var c=[];c.push('<span class="chip g">'+DB.length+' players</span>');c.push('<span class="chip">Stats updated '+esc(META.updated||'—')+'</span>');
 c.push('<span class="chip">Schedule: '+(GAMES.length?GAMES.length+' games':'none loaded')+'</span>');c.push('<span class="chip">Lines: '+(LINES.length?LINES.length+' feed':'manual')+'</span>');c.push('<span class="chip">Opened '+ftime()+'</span>');$('chips').innerHTML=c.join('')}
function nav(){var h=TABS.map(function(t){return '<button data-t="'+t[0]+'" class="'+(tab===t[0]?'on':'')+'"><i>'+t[1]+'</i>'+t[2]+'</button>'}).join('');$('navBot').innerHTML=h;$('navTop').innerHTML=TABS.map(function(t){return '<button data-t="'+t[0]+'" class="'+(tab===t[0]?'on':'')+'">'+t[2]+'</button>'}).join('')}
function roster(team){var k=norm(team);return DB.filter(function(p){return norm(p.team)===k}).map(function(p){return p.name})}
function gameCard(g,full){var a=roster(g.team1),b=roster(g.team2);return '<div class="card"><div class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+(g.bo?' · Bo'+esc(g.bo):'')+'</div><div class="big">'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</div>'+
 (full?'<div class="muted">'+esc(g.team1)+(rankOf(g.team1)?' #'+rankOf(g.team1):'')+': '+(a.join(', ')||'no roster data')+'</div><div class="muted">'+esc(g.team2)+(rankOf(g.team2)?' #'+rankOf(g.team2):'')+': '+(b.join(', ')||'no roster data')+'</div>':'')+'<div class="btns"><button class="g" data-act="gamegrade" data-i="'+g.id+'">See props</button></div></div>'}
function recents(){return load('gp_recent',[])}
function viewDash(){var ls=allLines().filter(function(l){return l.g}).sort(function(a,b){return Math.abs(b.g.edge/b.line)-Math.abs(a.g.edge/a.line)}).slice(0,5),rc=recents();
 var h='<div class="card"><h2>Player search</h2><div class="row"><input id="ds" list="plist" placeholder="Search a player, e.g. donk"><button class="b" style="flex:0 0 auto;margin:0" data-act="dsearch">Stats</button></div>'+(rc.length?'<div class="btns" style="margin-top:6px"><span class="muted" style="align-self:center">Recent:</span>'+rc.map(function(n){return '<button class="g" data-act="plview" data-p="'+esc(n)+'">'+esc(n)+'</button>'}).join('')+'<button class="g" data-act="rclear">Clear</button></div>':'')+'</div>';
 h+='<div class="grid c2"><div class="card"><h2>All games · '+GAMES.length+'</h2>'+(GAMES.length?'<div class="scroll" style="max-height:560px;overflow-y:auto">'+GAMES.map(function(g){return '<div class="item"><div><b>'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</b><br><span class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+'</span></div><button class="g" style="margin:0" data-act="gameopen">Rosters</button></div>'}).join('')+'</div>':'<div class="warn">No schedule loaded yet. Run the "Update CS2 data" workflow.</div>')+'</div>';
 h+='<div><div class="card"><h2>Top graded lines</h2>'+(ls.length?ls.map(function(l){return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(l.team)+'</span><br><span class="muted">'+sname(l.stat)+' · line '+l.line+' · proj '+l.g.proj+'</span></div><div><span class="pill '+(l.g.pick==='UNDER'?'u':'')+'">'+l.g.grade+' '+l.g.pick+'</span></div></div>'}).join(''):'<div class="warn">No lines yet. Add a PrizePicks line in the Lines tab.</div>')+'</div>';
 h+='<div class="card"><h2>Quick actions</h2><div class="btns"><button class="b" data-act="go" data-t="grader">Grade a prop</button><button class="g" data-act="go" data-t="lines">Lines</button><button class="g" data-act="go" data-t="slip">Slip ('+slip.length+')</button><button class="g" data-act="reload">Reload data</button></div></div></div></div>';return h+opts()}
function viewGames(){if(!GAMES.length)return '<div class="card"><h2>Games</h2><div class="warn">No schedule loaded yet. Run the "Update CS2 data" workflow once to create games.json.</div></div>';
 var days={};GAMES.forEach(function(g){var d=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'long',month:'short',day:'numeric'}).format(new Date(g.start));(days[d]=days[d]||[]).push(g)});
 return '<div class="muted" style="margin-bottom:8px">Schedule from bo3.gg, updated '+esc(META.games_at||'')+'. Times are Central. These are scheduled games, not live scores.</div>'+Object.keys(days).map(function(d){return '<h2>'+esc(d)+' · '+days[d].length+' games</h2><div class="grid c2">'+days[d].map(function(g){return gameCard(g,true)}).join('')+'</div>'}).join('')}
function viewLines(){var ls=allLines();
 var h='<div class="grid c2"><div class="card"><h2>PrizePicks + Underdog lines · Maps 1-2</h2>'+(LINES.length?'<div class="muted">Feed observed '+esc(META.lines_at||'')+'</div>':'<div class="warn">No lines feed is connected yet, so lines are manual. PrizePicks is the source of truth: type the line you see in the app.</div>')+
 (ls.length?ls.map(function(l,i){var g=l.g;return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(l.team)+(l.opp?' vs '+esc(l.opp):'')+'</span><br><span class="muted">'+(l.book?esc(l.book)+' · ':'')+sname(l.stat)+(l.start?' · '+esc(fmt(l.start)):'')+' · </span><b>'+l.line+'</b>'+(g?'<span class="muted"> · proj '+g.proj+' · over '+g.over+'/'+g.of+'</span>':'<span class="muted"> · no stats for this player</span>')+'</div><div style="text-align:right">'+(g?'<span class="pill '+(g.pick==='UNDER'?'u':'')+'">'+g.grade+' '+g.pick+'</span><br>':'')+'<button class="g" data-act="lg" data-i="'+i+'">Grade</button> <button class="g" data-act="ladd" data-i="'+i+'">+ Slip</button>'+(l.src==='manual'?' <button class="g" data-act="ldel" data-i="'+l.idx+'">✕</button>':'')+'</div></div>'}).join(''):'<div class="muted">No lines yet.</div>')+'</div>';
 h+='<div class="card"><h2>Add / edit a line</h2><label>Player</label><input id="mp" list="plist" placeholder="Start typing a player"><label>Stat</label><select id="ms"><option value="kills">Kills Maps 1-2</option><option value="hs">Headshots Maps 1-2</option></select><label>Opponent (optional)</label><input id="mo" list="tlist" placeholder="Team name"><label>Line</label><input id="ml" type="number" step="0.5" placeholder="e.g. 34.5"><button class="b" data-act="madd">Save line</button></div></div>';return h}
function opts(){var t={};DB.forEach(function(p){t[p.team]=1});return '<datalist id="plist">'+DB.map(function(p){return '<option value="'+esc(p.name)+'">'+esc(p.team)}).join('')+'</datalist><datalist id="tlist">'+Object.keys(t).sort().map(function(x){return '<option value="'+esc(x)+'">'}).join('')+'</datalist>'}
function viewGrader(){var p=find(sel.player),line=parseFloat(sel.line),g=p&&!isNaN(line)?grade(p,sel.stat,line,sel.opp):null;
 var h='<div class="grid c2"><div class="card"><h2>Prop grader</h2><label>Player</label><input id="gp" list="plist" value="'+esc(sel.player)+'" placeholder="Start typing a player"><div class="row"><div><label>Stat</label><select id="gs"><option value="kills"'+(sel.stat==='kills'?' selected':'')+'>Kills Maps 1-2</option><option value="hs"'+(sel.stat==='hs'?' selected':'')+'>Headshots Maps 1-2</option></select></div><div><label>Line</label><input id="gl" type="number" step="0.5" value="'+esc(sel.line)+'"></div></div><label>Opponent</label><input id="go" list="tlist" value="'+esc(sel.opp)+'" placeholder="Team name"><div class="btns"><button class="b" data-act="grade">Grade it</button></div></div>';
 if(!sel.player)h+='<div class="card"><div class="warn">Pick a player and a line to grade.</div></div>';
 else if(!p)h+='<div class="card"><div class="warn">No player named "'+esc(sel.player)+'" in the data.</div></div>';
 else if(!g)h+='<div class="card"><div class="warn">Not enough Maps 1-2 data for '+esc(p.name)+' yet (needs matches where both Map 1 and Map 2 were played) or the line is empty.</div></div>';
 else h+=gradeCard(g);return h+'</div>'+opts()}
function gradeCard(g){var v=g.cs.slice(0,10).map(function(c){return c[g.stat]}).filter(function(x){return x!=null});var mx=Math.max.apply(null,v.concat([g.line]))*1.1;
 var bars=v.slice().reverse().map(function(x){return '<div class="bar" title="'+x+'" style="height:'+(x/mx*100)+'%;background:'+(x>g.line?'var(--green)':x<g.line?'var(--red)':'#777')+'"></div>'}).join('');
 return '<div class="card"><div class="muted">'+esc(g.player)+' · '+esc(g.team)+(g.opp?' vs '+esc(g.opp):'')+' · '+sname(g.stat)+' · line '+g.line+'</div><div class="grade'+gclass(g.grade)+'">'+g.grade+'</div><div><span class="pill '+(g.pick==='UNDER'?'u':'')+'">'+esc(g.label)+'</span></div>'+
 '<div class="stats"><div class="st"><b>'+g.proj+'</b><span>Projection</span></div><div class="st"><b>'+(g.edge>=0?'+':'')+g.edge+'</b><span>Edge vs line</span></div><div class="st"><b>'+g.over+'/'+g.of+'</b><span>Over, last '+g.of+'</span></div></div>'+
 '<div class="bars"><div class="ln" style="bottom:'+(g.line/mx*100)+'%"></div>'+bars+'</div><div class="muted">Oldest to newest. Green = over, red = under.</div>'+
 '<h2 style="margin-top:12px">Breakdown</h2><div class="scroll"><table><tr><th>Part</th><th>Weight</th><th>Avg</th><th>Sample</th></tr>'+g.comp.map(function(c){return '<tr><td>'+esc(c.k)+'</td><td>'+Math.round(c.w*100)+'%</td><td>'+(c.v==null?'no data':c.v.toFixed(1))+'</td><td>'+c.n+'</td></tr>'}).join('')+'</table></div>'+
 '<div class="muted" style="margin-top:6px">'+esc(g.adj)+'. Parts with no data are left out and the other weights are scaled up. Blowout and role are not in the data.</div>'+
 '<div class="btns"><button class="b" data-act="gadd">Add to slip</button><button class="g" data-act="gimg">Download image</button><button class="g" data-act="gshare">Share</button></div>'+
 '<h2 style="margin-top:12px">Last 10 (Maps 1-2)</h2><div class="scroll"><table><tr><th>Date</th><th>Opp</th><th>Maps</th><th>'+(g.stat==='hs'?'HS':'Kills')+'</th></tr>'+g.cs.slice(0,10).map(function(c){return '<tr><td>'+esc(c.date)+'</td><td>'+esc(c.opp)+'</td><td>'+esc(c.maps)+'</td><td>'+(c[g.stat]==null?'':c[g.stat])+'</td></tr>'}).join('')+'</table></div></div>'}
function viewSlip(){var h='<div class="grid c2"><div class="card"><h2>Slip builder</h2><div class="btns"><button class="g" data-act="auto" data-n="2">Safe 2-Leg</button><button class="g" data-act="auto" data-n="3">Balanced 3-Leg</button><button class="g" data-act="auto" data-n="4">Degenerate 4-Leg</button></div><div class="muted" style="margin-top:6px">Auto slips use the strongest graded lines, one leg per player.</div></div>';
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
// ---- images (grade + translucent logo only)
function img(kind,cb){var c=document.createElement('canvas');c.width=1080;c.height=1350;var x=c.getContext('2d');x.fillStyle='#0a0a0a';x.fillRect(0,0,1080,1350);x.strokeStyle='#00FF66';x.lineWidth=10;x.strokeRect(24,24,1032,1302);
 var im=new Image();im.onload=function(){x.globalAlpha=.12;var w=760,h=w*im.height/im.width;x.drawImage(im,(1080-w)/2,(1350-h)/2,w,h);x.globalAlpha=1;draw();cb(c)};im.onerror=function(){draw();cb(c)};im.src='assets/logo.png';
 function draw(){x.textAlign='center';if(kind.g){var g=kind.g;x.fillStyle='#fff';x.font='700 54px sans-serif';x.fillText(g.player+' · '+sname(g.stat),540,200);x.fillText('LINE '+g.line+'  ·  PROJ '+g.proj,540,280);x.fillStyle=g.grade==='A+'||g.grade==='B'?'#00FF66':g.grade==='C'?'#ffc53d':'#ff4d6d';x.font='800 300px sans-serif';x.fillText(g.grade,540,640);x.font='800 60px sans-serif';x.fillText(g.label.toUpperCase(),540,760);x.fillStyle='#c8cdd2';x.font='400 36px sans-serif';x.fillText('Over '+g.over+'/'+g.of+' last '+g.of+(g.opp?'  ·  vs '+g.opp:''),540,840)}
  else{x.font='700 48px sans-serif';slip.slice(0,8).forEach(function(s,i){x.fillStyle='#fff';x.fillText(s.player+' '+sname(s.stat),540,230+i*120);x.fillStyle='#00FF66';x.fillText(s.pick+' '+s.line+(s.grade?'  ·  '+s.grade:''),540,282+i*120)})}}}
function dl(c,name){var a=document.createElement('a');a.download=name;a.href=c.toDataURL('image/png');document.body.appendChild(a);a.click();a.remove()}
function share(c,name){c.toBlob(function(b){var f=new File([b],name,{type:'image/png'});if(navigator.canShare&&navigator.canShare({files:[f]})){navigator.share({files:[f]}).then(function(){toast('Shared')}).catch(function(){toast('Share cancelled')})}else{dl(c,name);toast('Sharing not supported here. Image downloaded')}})}
function curGrade(){var p=find(sel.player);return p?grade(p,sel.stat,parseFloat(sel.line),sel.opp):null}
function addSlip(g){if(slip.some(function(s){return norm(s.player)===norm(g.player)&&s.stat===g.stat})){toast('Already on slip');return}slip.push({player:g.player,stat:g.stat,line:g.line,pick:g.pick,grade:g.grade});save('gp_slip',slip);toast('Added '+g.player+' '+g.pick+' '+g.line)}
function openP(n){sel.pl=n;sel.v='all';sel.o='';var r=recents().filter(function(x){return x!==n});r.unshift(n);save('gp_recent',r.slice(0,8));tab='players';render();window.scrollTo(0,0);toast('Stats for '+n)}
// ---- actions
document.addEventListener('click',function(e){var b=e.target.closest('[data-act],[data-t]');if(!b)return;
 if(b.dataset.t&&!b.dataset.act){go(b.dataset.t);return}
 var a=b.dataset.act,i=+b.dataset.i;
 if(a==='go')go(b.dataset.t);
 else if(a==='reload'){toast('Reloading…');boot()}
 else if(a==='gamegrade'){go('players');toast('Pick a player from the team to grade')}
 else if(a==='dsearch'){var nm=($('ds').value||'').trim(),pp=find(nm);if(!pp){toast('No player named "'+nm+'"');return}openP(pp.name)}
 else if(a==='plview'){openP(b.dataset.p)}
 else if(a==='rclear'){save('gp_recent',[]);render();toast('Search history cleared')}
 else if(a==='gameopen'){toast('Search a player to see his stats')}
 else if(a==='pclose'){sel.pl='';render();toast('Back to list')}
 else if(a==='pgrade'){var pp2=find(sel.pl);sel.player=pp2.name;sel.line=sel.stat==='hs'?(sel.l2||''):(sel.l1||'');sel.opp=sel.o||'';go('grader');toast('Loaded '+pp2.name+' in the grader')}
 else if(a==='pg'){sel.player=b.dataset.p;var p=find(sel.player);sel.opp='';go('grader');toast('Loaded '+sel.player+'. Enter a line')}
 else if(a==='grade'){sel.player=$('gp').value;sel.stat=$('gs').value;sel.line=$('gl').value;sel.opp=$('go').value;render();toast('Graded')}
 else if(a==='gadd'){var g=curGrade();if(g)addSlip(g)}
 else if(a==='gimg'){var g2=curGrade();if(g2)img({g:g2},function(c){dl(c,'grade-1080x1350.png');toast('Image downloaded')})}
 else if(a==='gshare'){var g3=curGrade();if(g3)img({g:g3},function(c){share(c,'grade.png')})}
 else if(a==='madd'){var n=$('mp').value.trim(),l=parseFloat($('ml').value);if(!n||isNaN(l)){toast('Enter a player and a line');return}var p2=find(n);manual.push({player:p2?p2.name:n,team:p2?p2.team:'',stat:$('ms').value,line:l,opponent:$('mo').value,period:'Maps 1-2',src:'manual'});save('gp_manual',manual);render();toast('Line saved')}
 else if(a==='ldel'){manual.splice(i-LINES.length,1);save('gp_manual',manual);render();toast('Line removed')}
 else if(a==='lg'){var l2=allLines()[i];sel={player:l2.player,stat:l2.stat,line:String(l2.line),opp:l2.opp};go('grader');toast('Loaded '+l2.player)}
 else if(a==='ladd'){var l3=allLines()[i];if(!l3.g){toast('No stats for '+l3.player);return}addSlip(l3.g);render()}
 else if(a==='auto'){var n2=+b.dataset.n,seen={},pool=allLines().filter(function(l){return l.g}).sort(function(x,y){return Math.abs(y.g.edge/y.line)-Math.abs(x.g.edge/x.line)}),out=[];pool.forEach(function(l){if(out.length<n2&&!seen[norm(l.player)]){seen[norm(l.player)]=1;out.push({player:l.player,stat:l.stat,line:l.line,pick:l.g.pick,grade:l.g.grade})}});if(!out.length){toast('No graded lines yet. Add lines first');return}slip=out;save('gp_slip',slip);render();toast('Built '+out.length+'-leg slip'+(out.length<n2?' (only '+out.length+' lines available)':''))}
 else if(a==='sdel'){slip.splice(i,1);save('gp_slip',slip);render();toast('Removed')}
 else if(a==='sclear'){slip=[];save('gp_slip',slip);render();toast('Slip cleared')}
 else if(a==='scopy'){var t=slip.map(function(s){return s.player+' '+sname(s.stat)+' '+s.pick+' '+s.line}).join('\n');(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){toast('Copied')}).catch(function(){toast('Copy not allowed here')})}
 else if(a==='spp'){window.open('https://app.prizepicks.com','_blank','noopener');toast('Opening PrizePicks. Enter your picks there')}
 else if(a==='simg'){if(!slip.length){toast('Slip is empty');return}img({},function(c){dl(c,'slip-1080x1350.png');toast('Image downloaded')})}
 else if(a==='sshare'){if(!slip.length){toast('Slip is empty');return}img({},function(c){share(c,'slip.png')})}
});
document.addEventListener('input',function(e){if(e.target.id==='pq'){sel.q=e.target.value;var pos=e.target.selectionStart;render();var n=$('pq');n.focus();n.setSelectionRange(pos,pos)}});
document.addEventListener('change',function(e){var i=e.target.id,m={pt:'tm',pn:'n',pv:'v',po:'o',pl1:'l1',pl2:'l2'};if(m[i]){sel[m[i]]=e.target.value;render();toast('Updated')}});
// ---- data
function getJSON(u){return fetch(u+'?'+Date.now()).then(function(r){if(!r.ok)throw 0;return r.json()})}
function boot(){Promise.all([getJSON('players.json'),getJSON('games.json').catch(function(){return null}),getJSON('lines.json').catch(function(){return null})]).then(function(r){
 DB=r[0].players||[];RANK=r[0].ranks||{};META.updated=r[0].updated||'';
 GAMES=(r[1]&&r[1].games||[]).filter(function(g){return g.start}).sort(function(a,b){return a.start<b.start?-1:1});META.games_at=r[1]?r[1].updated:'';
 LINES=(r[2]&&r[2].lines)||[];META.lines_at=r[2]&&r[2].observed_at?fmt(r[2].observed_at):'';render();
 }).catch(function(){$('main').innerHTML='<div class="card"><div class="warn">Could not load players.json. Open this from the hosted site.</div></div>';nav()})}
nav();boot();
})();
