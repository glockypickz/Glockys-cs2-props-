(function(){
'use strict';
var $=function(i){return document.getElementById(i)};
// Grades come from model.js (GPModel): v1 projection + v1 letter cutoffs, with a v2 Under break-even rule for D vs F.
// Letter from (proj-line)/line: A+ >= +15%, B >= +5%, C >= -2%, D >= -10%, else F. Pick is OVER if proj >= line, else UNDER.
// When the pick is Under and the letter is D or F, F requires P(under) at least +3pp over the book's break-even; otherwise D.
// No plain A, no hit-rate letter override. Filter reasons show as a flag; they do not change the letter.
// Locked picks never change. Pre-v2 locks show as e.g. "A+ (old)". v2 and current (v1be) locks show their stored letter.
var GLABEL={'A+':'Excellent Over','A':'Excellent Over','B':'Lean Over','C':'Slight Over lean','D':'Slight Under lean','F':'Take the Under'};
var GRADE_LEGEND='Grades (v1 projection vs the line): A+ = projection 15%+ above the line, B = 5-15% above, C = within about 2% below to 5% above, D = Under whose chance is under +3pp vs break-even (or 2-10% below the line before that test), F = Under +3pp or more vs break-even (or more than 10% below the line if that test does not apply). A flag means a filter fired (few series, team mismatch, stand-in).';
function isPlay(g){return !!g&&(g.grade==='A+'||g.grade==='A'||g.grade==='B'||g.grade==='F')&&!(g.reasons&&g.reasons.length)}
// hit-rate boxes vs the current line (x/n series over, earlier Maps 1-2 series only): green above 50%, red below
// keys: which boxes. Prop cards (grading) show the season view: SZN, H2H, L20. L5 / L10 / L15 are research windows for the Players tab only.
function hitBoxes(h,keys){if(!h)return '';var NAMES={l5:'L5',l10:'L10',l15:'L15',l20:'L20',h2h:'H2H',szn:'SZN'};return '<div class="hbs">'+(keys||['l5','l10','l15','l20','h2h','szn']).map(function(k){return[NAMES[k],k]}).map(function(a){var v=h[a[1]]||[0,0],x=v[0],n=v[1],c=n?(x/n>0.5?' g':x/n<0.5?' r':''):' na';return '<span class="hb'+c+'" title="'+a[0]+': went over this line in '+x+' of '+n+' series"><i>'+a[0]+'</i>'+(n?x+'/'+n:'–')+'</span>'}).join('')+'</div>'}
function pillTxt(g){return g.grade+' '+g.pick+(g.reasons&&g.reasons.length?' ⚑':'')}
function baitBadge(g){return g&&g.bait?' <span class="pill bait" title="Hit this line in each of the last 5 Maps 1-2 series (met or beat the line)">BAIT</span>':''}
function gradePill(g){return '<span class="pill '+(g.pick==='UNDER'?'u':'')+'">'+pillTxt(g)+'</span>'+baitBadge(g)}
function glabel(m){return GLABEL[m.grade]+' · '+m.pick+' '+pc1(m.pPick)+(m.reasons&&m.reasons.length?' · ⚑ '+m.reasons.join('; '):'')}
function oldG(lk){return !lk?'':(lk.model==='v2'||lk.model==='v1be')?lk.grade:lk.grade+' (old)'} // pre-v2 letters meant something else; v2 and current locks keep their stored letter
function gradesIn(rows){var all=['A+','B','C','D','F','A+ (old)','B (old)','C (old)','D (old)','F (old)'];rows.forEach(function(x){if(all.indexOf(x.grade)<0)all.push(x.grade)});return all.filter(function(G){return rows.some(function(x){return x.grade===G})})}
var MCTX=null,MCTXN=-1;
function mctx(){if(!MCTX||MCTXN!==DB.length){MCTX=GPModel.build(DB,null,STRENGTH,RANK);MCTXN=DB.length}return MCTX} // STRENGTH = team_strength.json (Cito-derived), null if absent; RANK = players.json ordinal ranks for the v1 same-tier term
function pc1(x){return x==null||isNaN(x)?'–':(x*100).toFixed(1)+'%'}
var STRENGTH=null,DB=[],RANK={},GAMES=[],LINES=[],HIST=null,META={updated:'',lines_at:'',games_at:'',games_iso:''};
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
function combos(p){var by={};(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&l.mid!=null){var g=by[l.mid]=by[l.mid]||{mid:l.mid,date:l.date,opp:l.opp,m:{},kills:0,hs:0,hsOk:true,rd:0,rdOk:true,d:0,dOk:true,a:0,aOk:true,adr:[],ev:{},x:{}};g.m[l.n]=l.map;g.kills+=Number(l.kills)||0;if(l.n===1&&l.kills!=null)g.kills1=Number(l.kills);
 if(l.hs==null)g.hsOk=false;else g.hs+=Number(l.hs)||0;if(l.rd==null)g.rdOk=false;else g.rd+=Number(l.rd)||0;if(l.d==null)g.dOk=false;else g.d+=Number(l.d)||0;if(l.a==null)g.aOk=false;else g.a+=Number(l.a)||0;if(l.adr!=null)g.adr.push(Number(l.adr));if(l.ev)g.ev[l.ev]=1;
 if(l.x)for(var k in l.x){(g.x[k]=g.x[k]||[]).push(l.x[k])}}});
 return Object.keys(by).map(function(k){return by[k]}).filter(function(g){return g.m[1]&&g.m[2]}).map(function(g){var evs=Object.keys(g.ev),x={};for(var k in g.x)x[k]=g.x[k].reduce(function(a,b){return a+b},0);
  return{mid:g.mid,date:g.date,opp:g.opp,maps:g.m[1]+' + '+g.m[2],kills:g.kills,kills1:g.kills1,hs:g.hsOk?g.hs:null,rounds:g.rdOk?g.rd:null,deaths:g.dOk?g.d:null,assists:g.aOk?g.a:null,adr:g.adr.length?g.adr.reduce(function(a,b){return a+b},0)/g.adr.length:null,ev:evs.length===1?evs[0]:null,x:x}}).sort(function(a,b){return a.date<b.date?1:a.date>b.date?-1:(String(a.mid)<String(b.mid)?1:String(a.mid)>String(b.mid)?-1:0)})}
function mean(a){return a.length?a.reduce(function(x,y){return x+y},0)/a.length:null}
function sd(a){var m=mean(a);return a.length?Math.sqrt(mean(a.map(function(x){return (x-m)*(x-m)}))):0}
function nums(cs,st){return cs.map(function(c){return c[st]}).filter(function(x){return x!=null})}
function tier(r){return r<=5?'Top 5':r<=15?'Top 6-15':r<=30?'Top 16-30':'Top 31+'}
// ---- days (Central), team matching, live status
// Central date: one shared formatter (building an Intl formatter per call was the Games-tab lag), memoized per timestamp string
var CDAY_F=null,CDAY_M={},CDAY_N=0;
function cday(iso){if(iso&&CDAY_M.hasOwnProperty(iso))return CDAY_M[iso];var d=iso?new Date(iso):new Date();if(isNaN(d))return '';
 if(!CDAY_F)CDAY_F=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'});
 var o={};CDAY_F.formatToParts(d).forEach(function(p){o[p.type]=p.value});var r=o.year+'-'+o.month+'-'+o.day;
 if(iso){if(++CDAY_N>20000){CDAY_M={};CDAY_N=0}CDAY_M[iso]=r}return r}
function addDays(ymd,n){var d=new Date(ymd+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function dayLabel(ymd){var t=cday();if(ymd===t)return 'Today';if(ymd===addDays(t,1))return 'Tomorrow';return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(ymd+'T12:00:00Z'))}
var TN_M={};function tn(s){var k=s==null?'':String(s);return TN_M.hasOwnProperty(k)?TN_M[k]:(TN_M[k]=GPModel.tn(k))} // team key with book/bo3.gg aliases (model.js TEAM_ALIASES)
function teq(a,b){a=tn(a);b=tn(b);return !!a&&a===b}
// Display only: this-season Maps 1-2 average vs opp over the last `n` meetings dated strictly before `before`.
// Not an input to the v1be projection or letter. If fewer than n meetings exist, uses those. None -> "–".
function h2hSeasonWindow(cs,st,opp,n,before){before=before||'9999';if(!opp)return{n:0,avg:null,txt:'–'};
 var yr=before!=='9999'?String(before).slice(0,4):(cs.length&&cs[0].date?String(cs[0].date).slice(0,4):String(new Date().getFullYear()));
 var rows=cs.filter(function(c){return c.date<before&&String(c.date).slice(0,4)===yr&&teq(c.opp,opp)&&c[st]!=null});
 var w=rows.slice(0,n),avg=mean(nums(w,st));if(!w.length||avg==null)return{n:0,avg:null,txt:'–'};
 return{n:w.length,avg:avg,txt:'avg '+avg.toFixed(1)+' over '+w.length+' meeting'+(w.length===1?'':'s')}}
function h2hSeasonRows(cs,st,opp,before){return[10,15].map(function(n){var h=h2hSeasonWindow(cs,st,opp,n,before);return{k:'H2H last '+n+' (this season)',txt:h.txt,v:null,n:h.n||'',f:1}})}
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
var ALIASES={"4Z":"EP.-4Z","Ag1l":"agl"};
function canon(s){var k=norm(s).replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e').replace(/4/g,'a').replace(/5/g,'s').replace(/7/g,'t');return k.replace(/(.)\1+/g,'$1')}
var IDX=null,IDXN=-1,FM={};
function pIndex(){if(IDX&&IDXN===DB.length)return IDX;IDX={exact:{},canon:{}};IDXN=DB.length;FM={};
 DB.forEach(function(p){var e=norm(p.name),c=canon(p.name);(IDX.exact[e]=IDX.exact[e]||[]).push(p);(IDX.canon[c]=IDX.canon[c]||[]).push(p)});return IDX}
function nlogs(p){return (p.logs||[]).length}
function pickBest(a){return a.slice().sort(function(x,y){return nlogs(y)-nlogs(x)})[0]}
function find(name,team){
 var ix=pIndex(),k=norm(name),mk=k+'|'+norm(team||'');if(mk in FM)return FM[mk];
 var r=null,ex=ix.exact[k];
 var onTeam=function(a){return team?(a||[]).filter(function(p){return teq(p.team,team)}):(a||[])};
 if(ex){var exT=onTeam(ex);if(exT.length)r=pickBest(exT)}
 if(!r&&ALIASES[name]){var a=onTeam(ix.exact[norm(ALIASES[name])]);if(a.length)r=pickBest(a)}
 if(!r&&k.length>=3){
  var cs=ix.canon[canon(name)];
  if(cs){var pool=onTeam(cs);if(pool.length===1)r=pool[0]}
 }
 if(!r&&team){ // same team only: one name contained in the other (tags like "EP.-4Z"), real history required
  var c=canon(name),cand=DB.filter(function(p){if(!teq(p.team,team)||nlogs(p)<6)return false;var d=canon(p.name),sh=d.length<c.length?d:c,lo=d.length<c.length?c:d;return sh.length>=4&&lo.indexOf(sh)>-1});
  if(cand.length===1)r=cand[0]}
 FM[mk]=r||undefined;return FM[mk]}
// ---- grader v2 (model.js): decayed per-round rate shrunk to the team, Elo strength + expected rounds, negative binomial P(over)
// o = {team, book, odds, before}; before = 'YYYY-MM-DD' grades with data from before that day only (track record)
function grade(p,st,line,opp,o){o=o||{};var cs=combos(p);var v=nums(cs,st);if(!v.length||isNaN(line))return null;
 var m=GPModel.grade(mctx(),p,st,line,opp,{team:o.team||'',book:o.book,odds:o.odds,before:o.before});if(!m)return null;
 var yr=cs.length?cs[0].date.slice(0,4):'',last=nums(cs.filter(function(c){return c.date.slice(0,4)===yr}),st),over=last.filter(function(x){return x>line}).length; // full season (calendar year), not a short window
 var det=m.v1||{},comp=(det.parts||[]).map(function(p){return{k:p.label+' (weight '+p.w.toFixed(2)+')',v:p.v,n:p.n,f:1}});
 if(opp)comp=comp.concat(h2hSeasonRows(cs,st,opp,o.before));
 if(det.adr5!=null||det.adrc!=null){comp.push({k:'ADR nudge (last 5 vs all series, cap 5%)',v:det.adrUsed?((det.adrMult-1)*100):null,n:det.adrN5,f:1,u:'%'});
  if(det.adr5!=null)comp.push({k:'ADR, last 5 series',v:det.adr5,n:det.adrN5,f:1});
  if(det.adrc!=null)comp.push({k:'ADR, all series',v:det.adrc,n:det.adrN,f:1})}
 if(m.underBe&&m.underBe.applied)comp.push({k:'P(under) vs break-even (F if at least +3pp, else D)',v:m.underBe.epp,n:null,f:1,u:'pp'});
 var used=(det.parts||[]).filter(function(p){return p.v!=null}),mix=used.map(function(p){return p.label+' '+p.v.toFixed(1)+' \xd7 '+p.w.toFixed(2)}).join(', ');
 var redis=det.weightSum!=null&&Math.abs(det.weightSum-1)>1e-6,nudgeTxt=det.adrUsed?(', then an ADR nudge of '+(det.adrMult>=1?'+':'')+((det.adrMult-1)*100).toFixed(1)+'% (capped at 5%) from last 5 series vs overall ADR'):', with no ADR nudge';
 var beNote='When the pick is Under and the letter is D or F, F requires P(under) at least +3pp over the book\'s break-even; otherwise D';
 if(m.underBe&&m.underBe.applied)beNote+=' (here P(under) '+pc1(m.underBe.pu)+', break-even '+pc1(m.underBe.be)+', '+(m.underBe.epp>=0?'+':'')+m.underBe.epp.toFixed(1)+'pp, so '+m.grade+')';
 if(opp)beNote+='. H2H last 10 / last 15 (this season) are shown for reference only and are not used in the projection or the letter';
 var adj='Projection '+m.proj.toFixed(1)+' is the v1 mix'+(mix?': '+mix:'')+(redis?' (missing windows dropped, their weight redistributed)':'')+nudgeTxt+'. P(over) '+pc1(m.pOver)+(m.pPush>0.0005?' (push '+pc1(m.pPush)+')':'')+'. Break-even '+pc1(m.be)+(o.book?' ('+o.book+')':' (PrizePicks default)')+'. Edge '+(m.edgePP>=0?'+':'')+m.edgePP.toFixed(1)+'pp. '+beNote+(m.reasons.length?'. No play: '+m.reasons.join('; '):'');
 var label=glabel(m);
 return{player:p.name,team:p.team,stat:st,line:line,opp:opp||'',proj:+m.proj.toFixed(1),edge:+m.edge.toFixed(1),grade:m.grade,label:label,pick:m.pick,pOver:m.pOver,pPick:m.pPick,be:m.be,edgePP:m.edgePP,reasons:m.reasons,comp:comp,over:over,of:last.length,sd:+sd(last).toFixed(1),cs:cs,adj:adj,book:o.book||'',hits:m.hits||null,bait:!!m.bait}}
// ---- combo props ("A + B + C"): sum of each player's own projection vs the combined line
function isCombo(n){return String(n||'').indexOf('+')>-1}
function gradeCombo(name,team,st,line,opp,o){o=o||{};
 var names=String(name).split('+').map(function(x){return x.trim()}).filter(Boolean);if(names.length<2||isNaN(line))return null;
 var ps=[],series=[];
 for(var i=0;i<names.length;i++){var p=find(names[i],team);if(!p)return{missing:names[i]};ps.push(p);series.push(combos(p))}
 var m=GPModel.gradeCombo(mctx(),ps,names,st,line,opp,{team:team||'',book:o.book,odds:o.odds,before:o.before});if(!m)return{missing:names[0]};
 var parts=m.parts.map(function(x){return{name:x.name,proj:+x.proj.toFixed(1),n:x.n}}),proj=m.proj;
 var joint=[];if(series.length){series[0].forEach(function(c0){var rows=[c0],ok=true;for(var j=1;j<series.length;j++){var m=series[j].filter(function(c){return String(c.mid)===String(c0.mid)})[0];if(!m){ok=false;break}rows.push(m)}
  if(!ok||rows.some(function(r){return r[st]==null}))return;joint.push({mid:c0.mid,date:c0.date,opp:c0.opp,maps:c0.maps,kills:rows.reduce(function(a,r){return a+r.kills},0),hs:rows.every(function(r){return r.hs!=null})?rows.reduce(function(a,r){return a+r.hs},0):null})})}
 proj=+proj.toFixed(1);var edge=proj-line;
 var label=glabel(m);
 var last=nums(joint.slice(0,10),st),over=last.filter(function(x){return x>line}).length;
 return{player:name,team:team||'',stat:st,line:line,opp:opp||'',proj:proj,edge:+edge.toFixed(1),grade:m.grade,label:label,pick:m.pick,pOver:m.pOver,pPick:m.pPick,be:m.be,edgePP:m.edgePP,reasons:m.reasons,
  comp:parts.map(function(x){return{k:x.name+' projection',v:x.proj,n:x.n,f:1}}).concat(opp?h2hSeasonRows(joint,st,opp,o.before):[]),over:over,of:last.length,sd:+sd(last).toFixed(1),cs:joint,book:o.book||'',
  adj:'Combo: the sum of each player\'s own projection ('+parts.map(function(x){return x.name+' '+x.proj}).join(' + ')+'), P(over) '+pc1(m.pOver)+', break-even '+pc1(m.be)+', edge '+(m.edgePP>=0?'+':'')+m.edgePP.toFixed(1)+'pp'+(m.reasons.length?'. No play: '+m.reasons.join('; '):'')+'. When the pick is Under and the letter is D or F, F requires P(under) at least +3pp over the book\'s break-even; otherwise D. Chart and over count use only series where all '+names.length+' played together'+(joint.length?' ('+joint.length+' found)':' (none found yet)'),bait:false}}
function gradeFor(name,team,st,line,opp,o){o=o||{};if(isCombo(name))return gradeCombo(name,team,st,line,opp,o);var p=find(name,team);return p?grade(p,st,line,opp,{team:team||'',book:o.book,odds:o.odds,before:o.before}):null}
function gclass(g){return g==='A+'||g==='A'||g==='B'||g==='F'?'':g==='C'||g==='D'?' mid':' low'}
function sname(s){return s==='hs'?'Headshots Maps 1-2':'Kills Maps 1-2'}
function normStat(s){s=String(s||'').toLowerCase();return s.indexOf('head')>-1||s==='hs'?'hs':s.indexOf('kill')>-1?'kills':null}
// ---- all lines = feed + manual
function allLines(){var out=[];LINES.concat(manual).forEach(function(l,i){var st=normStat(l.stat);if(!st)return;var per=String(l.period||'Maps 1-2');if(per.replace(/\s/g,'').toLowerCase().indexOf('maps1-2')<0&&per.indexOf('1-2')<0&&l.src!=='manual')return;
 var combo=isCombo(l.player),p=combo?null:find(l.player,l.team);var o={player:l.player,team:l.team||(p&&p.team)||'',stat:st,line:+l.line,opp:l.opponent||'',src:l.src||'feed',idx:i,book:l.book||'',odds:l.odds,start:l.starts_at||''};var G=gradeFor(l.player,l.team,st,o.line,o.opp,{book:o.book,odds:o.odds});o.g=G&&!G.missing?G:null;o.miss=G&&G.missing?G.missing:'';out.push(o)});return out}
// ---- views
function chips(){var c=[];c.push('<span class="chip g">'+DB.length+' players</span>');c.push('<span class="chip">Stats updated '+esc(META.updated||'—')+'</span>');
 c.push('<span class="chip'+(liveGames().length?' g':'')+'">Games: '+(GAMES.length?liveGames().length+' live · '+upGames().length+' upcoming':'none loaded')+'</span>');c.push('<span class="chip">Lines: '+(LINES.length?LINES.length+' feed':'manual')+'</span>');c.push('<span class="chip">Opened '+ftime()+'</span>');$('chips').innerHTML=c.join('')}
// Shadow tab: admin only. The Worker hands out lines_history.json only to the admin (key header, or your logged-in admin account), so HIST loaded there means admin.
// On the public github.io copy that file is open to anyone, so there the tab needs the admin key on the device.
function shadowOK(){return !!HIST&&(!!adminKey()||!/github\.io$/i.test(location.hostname))}
function tabs(){return TABS.concat(shadowOK()?[['shadow','◐','Shadow']]:[])}
function nav(){var h=tabs().map(function(t){return '<button data-t="'+t[0]+'" class="'+(tab===t[0]?'on':'')+'"><i>'+t[1]+'</i>'+t[2]+'</button>'}).join('');$('navBot').innerHTML=h;$('navTop').innerHTML=tabs().map(function(t){return '<button data-t="'+t[0]+'" class="'+(tab===t[0]?'on':'')+'">'+t[2]+'</button>'}).join('')}
function roster(team){return DB.filter(function(p){return teq(p.team,team)}).map(function(p){return p.name})}

// Official match streams from games.json (bo3.gg match detail). Embeds: Twitch and YouTube only, never a proxy.
// Twitch parent must include the production hosts plus the current hostname (Pages preview, localhost, etc.).
function twitchParents(){var req=["glockys-cs2-props.dpe364.workers.dev","glockypickz.github.io"],h=(typeof location!=="undefined"&&location.hostname)||"";
 if(h&&req.indexOf(h)<0)req.push(h);return req}
function ytId(u){var m=String(u||"").match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);return m?m[1]:null}
function twitchChan(u){var s=String(u||""),q=s.match(/player\.twitch\.tv\/?\?[^#]*channel=([A-Za-z0-9_]+)/i);if(q)return q[1];
 var p=s.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);return p&&["videos","directory","settings","p","popout"].indexOf(p[1].toLowerCase())<0?p[1]:null}
function kickChan(u){var m=String(u||"").match(/(?:player\.)?kick\.com\/([A-Za-z0-9_]+)/i);return m?m[1]:null}
function platName(p){return p==="twitch"?"Twitch":p==="youtube"?"YouTube":p==="kick"?"Kick":(p||"Stream")}
function streamInfo(s){var url,plat,name,lang,official;
 if(typeof s==="string"){url=s;plat="";name="";lang="";official=false}
 else if(s&&typeof s==="object"){url=s.url||"";plat=s.platform||"";name=s.name||"";lang=s.language||"";official=!!s.official}
 else return null;
 if(!/^https:\/\//.test(url))return null;
 if(!plat){if(ytId(url))plat="youtube";else if(twitchChan(url))plat="twitch";else if(kickChan(url))plat="kick"}
 if(!name)name=twitchChan(url)||kickChan(url)||ytId(url)||"";
 var embed=null;
 if(plat==="twitch"&&twitchChan(url))embed="https://player.twitch.tv/?channel="+encodeURIComponent(twitchChan(url))+"&parent="+twitchParents().map(encodeURIComponent).join("&parent=");
 else if(plat==="youtube"&&ytId(url))embed="https://www.youtube.com/embed/"+encodeURIComponent(ytId(url));
 var label=platName(plat)+(name?" · "+name:"")+(lang?" · "+String(lang).toUpperCase():"")+(official?" · official":"");
 return {url:url,platform:plat,name:name,language:lang,official:official,embed:embed,label:label||url}}
function gameStreams(g){var out=[],seen={};(g&&g.streams||[]).forEach(function(s){var i=streamInfo(s);if(!i||seen[i.url])return;seen[i.url]=1;out.push(i)});return out}
function streamBlock(g,emptyNote){var xs=gameStreams(g);
 if(!xs.length)return emptyNote?'<div class="muted">No stream listed</div>':'';
 var open=sel.watch&&String(sel.watch.id)===String(g.id),best=0;xs.forEach(function(x,i){if(!x.embed)return;if(!xs[best].embed)best=i;else if(x.official&&!xs[best].official)best=i});
 var idx=open&&xs[sel.watch.s]&&xs[sel.watch.s].embed?sel.watch.s:best;
 var links='<div class="slinks">'+xs.map(function(x){return '<a class="slink" href="'+esc(x.url)+'" target="_blank" rel="noopener">'+esc(x.label)+'</a>'}).join("")+"</div>";
 var can=xs.some(function(x){return x.embed}),wbtn=can?'<button class="g" data-act="watch" data-i="'+g.id+'" data-s="'+(open?idx:best)+'">'+(open?"Hide player":"Watch")+"</button>":"";
 var player="";
 if(open&&xs[idx]&&xs[idx].embed){var alts=xs.map(function(x,i){return x.embed?'<button class="g'+(i===idx?" on":"")+'" data-act="watch" data-i="'+g.id+'" data-s="'+i+'">'+esc(platName(x.platform)+(x.name?" · "+x.name:""))+"</button>":""}).join("");
  player='<div class="player"><div class="player-frame"><iframe src="'+esc(xs[idx].embed)+'" title="'+esc(xs[idx].label)+'" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>'+(alts?'<div class="slinks">'+alts+"</div>":"")+"</div>"}
 return '<div class="streams">'+links+"</div>"+wbtn+player}
function gameCard(g,full){var a=roster(g.team1),b=roster(g.team2);return '<div class="card"><div class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+(g.bo?' · Bo'+esc(g.bo):'')+'</div><div class="big">'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</div>'+
 (full?'<div class="muted">'+esc(g.team1)+(rankOf(g.team1)?' #'+rankOf(g.team1):'')+': '+(a.join(', ')||'no roster data')+'</div><div class="muted">'+esc(g.team2)+(rankOf(g.team2)?' #'+rankOf(g.team2):'')+': '+(b.join(', ')||'no roster data')+'</div>':'')+(full?citoBlock(g):'')+'<div class="btns"><button class="g" data-act="gamegrade" data-i="'+g.id+'">See props</button></div>'+streamBlock(g,false)+'</div>'}
function recents(){return load('gp_recent',[])}
function viewDash(){var ls=allLines().filter(function(l){return l.g}).sort(function(a,b){return b.g.edgePP-a.g.edgePP}).slice(0,5),rc=recents(),dg=liveGames().concat(upGames());
 var h='<div class="card"><h2>Player search</h2><div class="row"><input id="ds" list="plist" placeholder="Search a player, e.g. donk"><button class="b" style="flex:0 0 auto;margin:0" data-act="dsearch">Stats</button></div>'+(rc.length?'<div class="btns" style="margin-top:6px"><span class="muted" style="align-self:center">Recent:</span>'+rc.map(function(n){return '<button class="g" data-act="plview" data-p="'+esc(n)+'">'+esc(n)+'</button>'}).join('')+'<button class="g" data-act="rclear">Clear</button></div>':'')+'</div>';
 h+='<div class="grid c2"><div class="card"><h2>Live + upcoming games · '+dg.length+'</h2>'+(dg.length?'<div class="scroll" style="max-height:560px;overflow-y:auto">'+dg.map(function(g){return '<div class="item"><div><b>'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</b>'+(g.status==='live'?' <span class="pill">LIVE</span>':'')+'<br><span class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+'</span></div><button class="g" style="margin:0" data-act="gamegrade" data-i="'+g.id+'">Props</button></div>'}).join('')+'</div>':'<div class="warn">No schedule loaded yet. Run the "Update CS2 games" workflow.</div>')+'</div>';
 h+='<div><div class="card"><h2>Top graded lines</h2>'+(ls.length?ls.map(function(l){return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(l.team)+'</span><br><span class="muted">'+sname(l.stat)+' · line '+l.line+' · proj '+l.g.proj+'</span></div><div>'+gradePill(l.g)+'</div></div>'}).join(''):'<div class="warn">No lines yet. Add a PrizePicks line in the Lines tab.</div>')+'</div>';
 h+='<div class="card"><h2>Quick actions</h2><div class="btns"><button class="b" data-act="go" data-t="grader">Grade a prop</button><button class="g" data-act="go" data-t="lines">Lines</button><button class="g" data-act="go" data-t="slip">Slip ('+slip.length+')</button><button class="g" data-act="reload">Reload data</button></div></div></div></div>';return h+recordCard()+opts()}
// ---- Cito panel on the Games tab (team_strength.json, built by cito_update.py; the site never calls Cito)
var CITO_S=null,CITO_SRC=null,CITO_RK={};
function citoS(){if(CITO_SRC!==STRENGTH){CITO_SRC=STRENGTH;CITO_S=GPModel.prepStrength(STRENGTH);CITO_RK={}}return CITO_S}
// newest snapshot dated before the match day (what the grader uses); if there is none, the newest one there is (flagged)
function citoSnap(h,day){if(!h||!h[0]||!h[0].length)return null;var i=0;while(i<h[0].length&&h[0][i]<day)i++;return i>0?{d:h[0][i-1],v:h[1][i-1]}:{d:h[0][h[0].length-1],v:h[1][h[1].length-1],late:1}}
function citoRank(kind,sn,k){var key=kind+sn.d,r=CITO_RK[key];if(!r){r=CITO_RK[key]={};var ks=Object.keys(sn.v);ks.forEach(function(t){var n=1;ks.forEach(function(u){if(sn.v[u]>sn.v[t])n++});r[t]=n})}return r[k]||null}
function citoOdds(g){var L=(STRENGTH&&STRENGTH.odds)||null;if(!L)return null;var a=tn(g.team1),b=tn(g.team2),t0=new Date(g.start).getTime(),best=null;
 L.forEach(function(o){var x=tn(o.n1||o.t1),y=tn(o.n2||o.t2),sw=x===b&&y===a;if(!(x===a&&y===b)&&!sw)return;var dt=Math.abs(new Date(o.start).getTime()-t0);if(!(dt<=12*3600000))return;
  if(!best||dt<best.dt)best={dt:dt,o:o,sw:sw}});if(!best)return{none:1};var o=best.o,f=function(v){return v&&best.sw?[v[1],v[0]]:v};
 return{p:f(o.p),dec:f(o.dec),map1:f(o.map1),map2:f(o.map2),src:o.src,at:o.at}}
function citoPct(p){return p==null?'–':Math.round(p*100)+'%'}
function citoMaps(sn){if(!sn)return '';var v=sn.v;return Object.keys(v).sort(function(a,b){return (v[b][2]-v[a][2])||(v[b][0]-v[a][0])}).slice(0,3).map(function(m){var x=v[m];return esc(m)+' '+(x[2]?Math.round(x[2])+'% pick, ':'')+x[0]+'×, '+(x[0]?(x[1]/x[0]).toFixed(1):'–')+' rds'}).join(' · ')}
function citoBlock(g){if(!STRENGTH)return '<div class="cito muted">No Cito data loaded (team_strength.json missing).</div>';
 var S=citoS(),P=GPModel.PARAMS,a=tn(g.team1),b=tn(g.team2),day=String(g.start||'').slice(0,10)||'9999',rows=[],notes=[],has={},asof={};
 var rk={};['vrs','world'].forEach(function(kind){var sn=citoSnap(S.rank[kind],day);if(!sn)return;var p1=Object.prototype.hasOwnProperty.call(sn.v,a)?sn.v[a]:null,p2=Object.prototype.hasOwnProperty.call(sn.v,b)?sn.v[b]:null;
  if(p1!=null)has.a=1;if(p2!=null)has.b=1;rk[kind]={p1:p1,p2:p2,sn:sn};asof[kind]=sn.d+(sn.late?' (newest)':'');
  rows.push([kind==='vrs'?'VRS':'World',p1!=null?'#'+citoRank(kind,sn,a)+' <span class="muted">'+Math.round(p1)+'</span>':'–',p2!=null?'#'+citoRank(kind,sn,b)+' <span class="muted">'+Math.round(p2)+'</span>':'–'])});
 var ps=[];Object.keys(rk).forEach(function(k){var r=rk[k];if(r.p1!=null&&r.p2!=null){var x=Math.pow(r.p1,P.rank_s),y=Math.pow(r.p2,P.rank_s);ps.push(x/(x+y))}});
 var pr=ps.length?ps.reduce(function(u,v){return u+v},0)/ps.length:null;if(pr!=null)rows.push(['Win (rank)',citoPct(pr),citoPct(1-pr)]);
 var ctx=DB.length?mctx():null,pm=null;if(ctx&&ctx.eloHist[a]&&ctx.eloHist[b]){pm=GPModel.pwin(ctx,g.team1,g.team2,day);rows.push(['Win (model)',citoPct(pm),citoPct(1-pm)])}
 var od=citoOdds(g);if(od&&od.p){rows.push(['Odds',citoPct(od.p[0])+(od.dec&&od.dec[0]?' <span class="muted">'+(+od.dec[0]).toFixed(2)+'</span>':''),citoPct(od.p[1])+(od.dec&&od.dec[1]?' <span class="muted">'+(+od.dec[1]).toFixed(2)+'</span>':'')]);
  if(od.map1)rows.push(['Map 1',citoPct(od.map1[0]),citoPct(od.map1[1])]);if(od.map2)rows.push(['Map 2',citoPct(od.map2[0]),citoPct(od.map2[1])]);has.o=1}
 var ma=citoSnap(S.maps[a],day),mb=citoSnap(S.maps[b],day);if(ma)has.a=1;if(mb)has.b=1;
 if(!has.a&&!has.b&&!has.o)return '<div class="cito muted">No Cito data for these teams.</div>';
 var h='<div class="cito"><table class="ct"><tr><th>Cito</th><th>'+esc(g.team1)+'</th><th>'+esc(g.team2)+'</th></tr>'+rows.map(function(r){return '<tr><td class="muted">'+r[0]+'</td><td>'+r[1]+'</td><td>'+r[2]+'</td></tr>'}).join('')+'</table>';
 if(ma||mb){var pw=pm!=null?pm:pr!=null?pr:0.5,base=P.rd_a+P.rd_b*pw*(1-pw),lc={P:P,S:{rank:{},maps:{}}};if(ma)lc.S.maps[a]=[[ma.d],[ma.v]];if(mb)lc.S.maps[b]=[[mb.d],[mb.v]];
  var em=GPModel.mapRounds(lc,g.team1,g.team2,'9999',base);if(em!=null)h+='<div class="muted">Expected rounds, Maps 1-2: <b>'+(2*em).toFixed(1)+'</b> from map stats · '+(2*(base+P.w_maps*(em-base))).toFixed(1)+' in the model</div>';
  if(ma)h+='<div class="muted"><b>'+esc(g.team1)+'</b> maps: '+citoMaps(ma)+'</div>';if(mb)h+='<div class="muted"><b>'+esc(g.team2)+'</b> maps: '+citoMaps(mb)+'</div>'}
 if(!has.a)notes.push('no Cito data for '+esc(g.team1));if(!has.b)notes.push('no Cito data for '+esc(g.team2));
 var src=[];if(asof.vrs||asof.world)src.push('rankings as of '+esc(asof.vrs||asof.world));if(ma||mb)src.push('map stats as of '+esc((ma||mb).d)+((ma||mb).late?' (newest)':'')+' (last 30 days)');
 if(od&&od.p)src.push('odds: '+esc(String(od.src||'').replace(/_/g,' '))+', '+esc(ftime(od.at)));else src.push(STRENGTH.odds?'odds: n/a for this match':'odds: n/a (needs Cito Pro)');
 return h+'<div class="muted cs">'+notes.concat(src).join(' · ')+'</div></div>'}
function liveCard(g){var sc=(g.s1!=null&&g.s2!=null)?' <span style="color:var(--green);margin-left:8px">'+g.s1+' – '+g.s2+'</span>':'';
 return '<div class="card"><div class="muted"><span class="pill">LIVE</span> '+esc(g.tournament||'')+' · started '+esc(ftime(g.start))+(g.bo?' · Bo'+esc(g.bo):'')+'</div><div class="big">'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+sc+'</div>'+citoBlock(g)+(function(){var m=matchFor(g);return m&&Object.keys(m.props).length?'<h3 style="margin:10px 0 4px">Prop tracker</h3>'+trackerBlock(m,true):''})()+'<div class="btns"><button class="g" data-act="gamegrade" data-i="'+g.id+'">See props</button><button class="g" data-act="gsub" data-v="started">Pre-game lines</button></div>'+streamBlock(g,true)+'</div>'}
// ---- Started games: pre-game line + live prop tracker (display only; nothing is saved).
// Pre-game line = the last line the lines feed saw before the start (lines_history.json keeps updating a line only until
// the match starts). Opening line = first seen. "Now" = the book's current line in lines.json when it differs.
// Live numbers: Maps 1-2 kills / headshots per player. bo3.gg posts a map's player stats only after that map ends, so
// the tracker moves map by map (Worker route /live/<match id>, polled about every minute while the Games tab is open),
// then from players.json once the results run has saved the match. There is no round-by-round feed.
var LIVE={},LIVE_T=0,LIVE_OK=null,PREG=null; // PREG: pregame.json (public: started props' pre-game lines only)
function pairKey(a,b,start){return [tn(a),tn(b)].sort().join('|')+'|'+cday(start)}
// display-only team match: same key, or one key is the start of the other (books write "ex-INOX" and "ex-INOX Division")
function sameTeam(a,b){a=tn(a);b=tn(b);if(!a||!b)return false;if(a===b)return true;var s=a.length<b.length?a:b,l=a.length<b.length?b:a;return s.length>=4&&l.indexOf(s)===0}
function sameMatch(m,a,b,start){return cday(m.start)===cday(start)&&((sameTeam(m.t1,a)&&sameTeam(m.t2,b))||(sameTeam(m.t1,b)&&sameTeam(m.t2,a)))}
function per12(l){var per=String(l.period||'Maps 1-2');return per.replace(/\s/g,'').toLowerCase().indexOf('maps1-2')>-1||per.indexOf('1-2')>-1}
var SM_C=null; // memo: rebuilt only when the feeds change or the minute ticks (it was rebuilt ~15x per render)
function startedMatches(){var mn=Math.floor(NOW()/60000),ck=FEED_V+'|'+mn+'|'+(HIST?'h':PREG?'p':'-');if(SM_C&&SM_C.k===ck)return SM_C.v;var v=buildStarted();SM_C={k:ck,v:v};PL_C={};return v}
function buildStarted(){var now=NOW(),today=cday(),M={},order=[],X={}; // X: exact pair key -> match key (fuzzy scan only on a miss)
 function mt(team,opp,start){var pk=pairKey(team,opp,start),k=X[pk]||null;
  if(!k)for(var i=0;i<order.length;i++)if(sameMatch(M[order[i]],team,opp,start)){k=order[i];break}
  if(!k){k=pk;M[k]={key:k,t1:team,t2:opp,start:start,props:{},game:null};order.push(k)}else if(start<M[k].start)M[k].start=start;X[pk]=k;return M[k]}
 function started(s){var t=new Date(s).getTime();return !isNaN(t)&&t<=now&&cday(s)===today}
 (HIST||PREG||[]).forEach(function(e){var st=normStat(e.stat);if(!st||!e.start||!started(e.start))return;var m=mt(e.team,e.opponent,e.start),k=norm(e.book)+'|'+norm(e.player)+'|'+st,o=m.props[k];
  if(o&&o.lock&&!e.lock)return; // same rule as the Track Record: a locked entry wins
  m.props[k]={book:e.book,player:e.player,team:e.team,opp:e.opponent,stat:st,open:e.first_line,pre:+e.line,now:null,lock:e.lock&&e.lock.grade?e.lock:null,result:e.result||null,odds:e.odds,start:e.start,hist:true}});
 LINES.forEach(function(l){var st=normStat(l.stat);if(!st||!l.starts_at||!started(l.starts_at)||!per12(l))return;var m=mt(l.team,l.opponent,l.starts_at),k=norm(l.book)+'|'+norm(l.player)+'|'+st,o=m.props[k];
  if(o){if(+l.line!==o.pre)o.now=+l.line}else m.props[k]={book:l.book,player:l.player,team:l.team,opp:l.opponent,stat:st,open:null,pre:+l.line,now:null,lock:null,result:null,odds:l.odds,start:l.starts_at,hist:false}});
 GAMES.forEach(function(g){if(!g.start||new Date(g.start).getTime()>now)return;var k=null;order.forEach(function(x){if(!k&&sameMatch(M[x],g.team1,g.team2,g.start))k=x});
  if(k){M[k].game=g;M[k].t1=g.team1;M[k].t2=g.team2;M[k].key=pairKey(g.team1,g.team2,g.start)}else if(isLive(g)){k=pairKey(g.team1,g.team2,g.start);M[k]={key:k,t1:g.team1,t2:g.team2,start:g.start,props:{},game:g};order.push(k)}});
 return order.map(function(k){return M[k]}).sort(function(a,b){return a.start<b.start?1:-1})}
function matchFor(g){return startedMatches().filter(function(m){return m.game===g||sameMatch(m,g.team1,g.team2,g.start)})[0]||null}
// Maps 1-2 total for one player: bo3.gg live (finished maps), else players.json logs. {v, maps:[n..], done}
function oneLive(m,name,team,opp,st){var L=m.game&&LIVE[m.game.id],got={},nm=norm(name),cn=canon(name);
 if(L&&L.players)L.players.forEach(function(p){if((p.n===1||p.n===2)&&(norm(p.name)===nm||canon(p.name)===cn)&&(!team||sameTeam(p.team,team)||!L.players.some(function(q){return q!==p&&q.n===p.n&&norm(q.name)===nm})))got[p.n]=st==='hs'?p.hs:p.kills});
 var p=find(name,team),day=cday(m.start);
 if(p)(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&got[l.n]==null&&sameTeam(l.opp,opp)&&Math.abs((new Date(l.date)-new Date(day))/864e5)<=1){var x=st==='hs'?l.hs:l.kills;if(x!=null)got[l.n]=x}});
 var ns=Object.keys(got).map(Number).sort();if(!ns.length)return null;var v=0;ns.forEach(function(n){v+=+got[n]});return{v:v,maps:ns}}
var PL_C={};
function propLive(m,r){var ck=m.key+'|'+norm(r.book)+'|'+norm(r.player)+'|'+r.stat+'|'+(m.game&&LIVE[m.game.id]?LIVE[m.game.id].at:'');if(PL_C.hasOwnProperty(ck))return PL_C[ck];return PL_C[ck]=propLive0(m,r)}
function propLive0(m,r){var names=isCombo(r.player)?r.player.split('+').map(function(s){return s.trim()}):[r.player],tot=0,maps=null;
 for(var i=0;i<names.length;i++){var x=oneLive(m,names[i],r.team,r.opp,r.stat);if(!x)return r.result&&r.result.act!=null?{v:r.result.act,done:true,src:'result'}:null;tot+=x.v;maps=maps?maps.filter(function(n){return x.maps.indexOf(n)>-1}):x.maps}
 var done=maps.length===2;if(!done&&r.result&&r.result.act!=null)return{v:r.result.act,done:true,src:'result'};return{v:tot,maps:maps,done:done}}
var PP_C={};function propPick(r){if(r.lock)return r.lock.pick;var ck=norm(r.book)+'|'+norm(r.player)+'|'+r.stat+'|'+r.pre+'|'+r.start;if(PP_C.hasOwnProperty(ck))return PP_C[ck];return PP_C[ck]=propPick0(r)}
function propPick0(r){if(isCombo(r.player))return null;var p=find(r.player,r.team);if(!p)return null;var g=grade(p,r.stat,r.pre,r.opp,{team:r.team,book:r.book,odds:r.odds,before:cday(r.start)});return g?g.pick:null}
function trackStatus(pick,line,lv){if(!lv)return{c:'',t:'waiting for map stats'};var v=lv.v;
 if(pick==='UNDER'){if(v>line)return{c:'lost',t:'Under lost'};if(lv.done)return v===line?{c:'',t:'push'}:{c:'cash',t:'Under cashed'};return{c:'run',t:(line-v).toFixed(1)+' under so far'}}
 if(v>line)return{c:'cash',t:'Over cashed'};if(lv.done)return v===line?{c:'',t:'push'}:{c:'lost',t:pick==='OVER'?'Over missed':'stayed under'};return{c:'run',t:'needs '+(Math.floor(line)+1-v)+' more'}}
function trackerBlock(m,compact){var rows=Object.keys(m.props).map(function(k){return m.props[k]}).sort(function(a,b){return (a.player<b.player?-1:a.player>b.player?1:0)||(a.stat<b.stat?-1:1)||(a.book<b.book?-1:1)});
 if(!rows.length)return '<div class="muted trk-none">No saved props for this match, so there is no pre-game line to show.</div>';
 var h='<div class="scroll trk"><table><tr><th>Player</th><th>Prop</th><th>Pre-game line</th><th>Now</th><th>Pick</th><th>Maps 1-2 so far</th><th>Status</th></tr>';
 rows.forEach(function(r){var lv=propLive(m,r),pick=propPick(r),s=trackStatus(pick,r.pre,lv),pct=lv?Math.min(100,Math.round(lv.v/Math.max(r.pre,1)*100)):0;
  var mv=(r.open!=null&&+r.open!==r.pre)?'<span class="muted"> (opened '+esc(r.open)+')</span>':'';
  h+='<tr class="'+(s.c==='cash'?'cashed':s.c==='lost'?'lostrow':'')+'"><td><b>'+esc(r.player)+'</b><div class="muted">'+esc(r.book||'')+'</div></td><td>'+(r.stat==='hs'?'HS':'Kills')+'</td>'+
   '<td><b>'+esc(r.pre)+'</b>'+mv+(r.hist?'':'<div class="muted">last line seen</div>')+'</td><td>'+(r.now!=null?'<b>'+esc(r.now)+'</b> <span class="muted">'+(r.now>r.pre?'▲':'▼')+' '+Math.abs(r.now-r.pre).toFixed(1)+'</span>':'<span class="muted">–</span>')+'</td>'+
   '<td>'+(pick?'<span class="pill'+(pick==='UNDER'?' u':'')+'">'+pick+'</span>'+(r.lock?' <span class="muted">'+esc(oldG(r.lock))+'</span>':''):'<span class="muted">–</span>')+'</td>'+
   '<td>'+(lv?'<b>'+esc(lv.v)+'</b> <span class="muted">/ '+esc(r.pre)+(lv.src==='result'?' · final':lv.done?' · both maps':' · map '+lv.maps.join('+')+' done')+'</span><div class="pbar"><i class="'+(s.c||'run')+'" style="width:'+pct+'%"></i></div>':'<span class="muted">–</span>')+'</td>'+
   '<td><span class="tst '+s.c+'">'+esc(s.t)+'</span></td></tr>'});
 return h+'</table></div>'+(compact?'':'<div class="muted cs">Pre-game line = last line seen before the start (opening line in brackets when it moved). Maps 1-2 so far comes from bo3.gg per finished map (it posts a map\'s stats only after the map ends, sometimes late), checked about every minute; there is no round-by-round feed.</div>')}
function startedCard(m){var g=m.game,live=g&&isLive(g),sc=g&&g.s1!=null&&g.s2!=null?' <span style="color:var(--green);margin-left:8px">'+g.s1+' – '+g.s2+'</span>':'';
 var L=g&&LIVE[g.id],maps=L&&L.maps?L.maps.map(function(x){return 'Map '+x.n+(x.map?' '+esc(String(x.map).replace(/^de_/,'')):'')+': '+esc(x.status||'?')+(x.score&&x.score[0]!=null?' '+x.score[0]+'-'+x.score[1]:'')}).join(' · '):'';
 return '<div class="card">'+'<div class="muted">'+(live?'<span class="pill">LIVE</span> ':'')+'started '+esc(ftime(m.start))+(g&&g.tournament?' · '+esc(g.tournament):'')+'</div><div class="big">'+esc(m.t1)+' <span class="vs">vs</span> '+esc(m.t2)+sc+'</div>'+(maps?'<div class="muted">'+maps+'</div>':'')+trackerBlock(m)+'</div>'}
function liveView(){var v=sel.gv||(liveGames().length?'live':'up');return tab==='games'&&(v==='live'||v==='started')&&!(typeof document!=='undefined'&&document.hidden)}
function pollLive(force){if(LIVE_OK===false||!liveView())return;if(typeof location!=='undefined'&&/github\.io$|^$/.test(location.hostname||''))return;if(!force&&NOW()-LIVE_T<55000)return;LIVE_T=NOW();
 var ids=startedMatches().filter(function(m){return m.game&&isLive(m.game)&&Object.keys(m.props).length}).map(function(m){return m.game.id});if(!ids.length)return;var changed=false;
 Promise.all(ids.map(function(id){return fetch('/live/'+encodeURIComponent(id)).then(function(r){if(r.status===404){LIVE_OK=false;return null}return r.ok?r.json():null}).then(function(d){if(!d||!d.maps)return;var o=LIVE[id];
  if(!o||JSON.stringify(o.maps)!==JSON.stringify(d.maps)||JSON.stringify(o.players)!==JSON.stringify(d.players)){LIVE[id]=d;changed=true}}).catch(function(){})})).then(function(){if(changed&&liveView()&&!document.getElementById('imgov'))render()})}
function viewGames(){if(!GAMES.length)return '<div class="card"><h2>Games</h2><div class="warn">No schedule loaded yet. Run the "Update CS2 games" workflow once to create games.json.</div></div>';
 var lv=liveGames(),up=upGames(),v=sel.gv||(lv.length?'live':'up'),age=gamesAge();
 var sm=startedMatches();pollLive();var h='<div class="btns" style="margin-bottom:10px"><button class="'+(v==='live'?'b':'g')+'" data-act="gsub" data-v="live">Live · '+lv.length+'</button><button class="'+(v==='started'?'b':'g')+'" data-act="gsub" data-v="started">Started today · '+sm.length+'</button><button class="'+(v==='up'?'b':'g')+'" data-act="gsub" data-v="up">Upcoming · '+up.length+'</button></div>';
 h+='<div class="muted" style="margin-bottom:8px">From bo3.gg, updated '+esc(META.games_at||'')+(age!=null?' ('+Math.round(age)+' min ago)':'')+'. Times are Central. Refreshes about every 10 minutes.</div>';
 if(age!=null&&age>90)h+='<div class="warn">This game data is '+(Math.round(age/6)/10)+' hours old, so live status may be out of date.</div>';
 if(v==='started'){if(!sm.length)return h+'<div class="card"><h2>Started today</h2><div class="muted">No match with saved props has started yet today (Central).</div></div>';
  var wp=sm.filter(function(m){return Object.keys(m.props).length}),np=sm.filter(function(m){return !Object.keys(m.props).length});
  return h+'<h2>Started today · props from their pre-game line</h2><div class="grid c2">'+wp.map(startedCard).join('')+'</div>'+(np.length?'<div class="muted" style="margin-top:8px">Started with no saved props (no pre-game line): '+np.map(function(m){return esc(m.t1)+' vs '+esc(m.t2)}).join(' · ')+'</div>':'')}
 if(v==='live'){
  if(!lv.length)return h+'<div class="card"><h2>Live</h2><div class="muted">No matches are live right now. A match shows here only while bo3.gg marks it live, and drops off when it finishes.</div></div>';
  return h+'<div class="grid c2">'+lv.map(liveCard).join('')+'</div><div class="muted" style="margin-top:8px">Stream links come from bo3.gg. Watch opens an official Twitch or YouTube embed in this page (one at a time). Kick and other platforms open in a new tab. The app does not rebroadcast or proxy video.</div>'}
 if(!up.length)return h+'<div class="card"><h2>Upcoming</h2><div class="muted">No upcoming matches in the schedule.</div></div>';
 var days={};up.forEach(function(g){var d=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'long',month:'short',day:'numeric'}).format(new Date(g.start));(days[d]=days[d]||[]).push(g)});
 return h+Object.keys(days).map(function(d){return '<h2>'+esc(d)+' · '+days[d].length+' games</h2><div class="grid c2">'+days[d].map(function(g){return gameCard(g,true)}).join('')+'</div>'}).join('')}
function lineDays(ls){var t=cday(),set={};set[t]=1;set[addDays(t,1)]=1;ls.forEach(function(l){if(l.start)set[cday(l.start)]=1});return Object.keys(set).sort().filter(function(d){return d>=t})}
function viewLines(){var ls=allLines(),days=lineDays(ls),cnt={},t0=cday();
 ls.forEach(function(l){var k=l.start?cday(l.start):t0;cnt[k]=(cnt[k]||0)+1});
 var d=sel.ld;if(!d||(d!=='all'&&days.indexOf(d)<0))d=cnt[t0]?t0:(days.filter(function(x){return cnt[x]})[0]||'all');
 var h='<div class="btns" style="margin-bottom:8px">'+days.map(function(x){return '<button class="'+(d===x?'b':'g')+'" data-act="lday" data-d="'+x+'">'+esc(dayLabel(x))+' · '+(cnt[x]||0)+'</button>'}).join('')+'<button class="'+(d==='all'?'b':'g')+'" data-act="lday" data-d="all">All · '+ls.length+'</button></div>';
 var bkey=function(l){var b=String(l.book||'').toLowerCase();return b.indexOf('prize')>-1?'pp':b.indexOf('underdog')>-1?'ud':'other'},bf=sel.lb||'all',bc={all:0,pp:0,ud:0};
 ls.forEach(function(l){var k=l.start?cday(l.start):t0;if(d==='all'||k===d){bc.all++;if(bkey(l)==='pp')bc.pp++;else if(bkey(l)==='ud')bc.ud++}});
 h+='<div class="btns" style="margin-bottom:8px">'+[['all','All books'],['pp','PrizePicks'],['ud','Underdog']].map(function(x){return '<button class="'+(bf===x[0]?'b':'g')+'" data-act="lbook" data-b="'+x[0]+'">'+x[1]+' · '+bc[x[0]]+'</button>'}).join('')+'</div>';
 var vis=[];ls.forEach(function(l,i){var k=l.start?cday(l.start):t0;if((d==='all'||k===d)&&(bf==='all'||bkey(l)===bf))vis.push([l,i])});
 vis.sort(function(a,b){var x=a[0].start||'9',y=b[0].start||'9';if(x!==y)return x<y?-1:1;var ea=a[0].g?a[0].g.edgePP:-999,eb=b[0].g?b[0].g.edgePP:-999;return eb-ea});
 h+='<div><div class="card"><h2>'+(d==='all'?'All lines':esc(dayLabel(d))+' lines')+' · '+(bf==='pp'?'PrizePicks':bf==='ud'?'Underdog':'PrizePicks + Underdog')+' · Maps 1-2</h2>'+(LINES.length?'<div class="muted">Feed observed '+esc(META.lines_at||'')+'. Refreshes about every hour. Times are Central.</div>':'<div class="warn">No lines feed is connected yet, so lines are manual. PrizePicks is the source of truth: type the line you see in the app.</div>')+
 (vis.length?vis.map(function(a){var l=a[0],i=a[1],g=l.g,live=l.team&&liveFor(l.team),started=l.start&&new Date(l.start).getTime()<NOW();return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(l.team)+(l.opp?' vs '+esc(l.opp):'')+'</span>'+(live?' <span class="pill">LIVE</span>':(started?' <span class="muted">· started</span>':''))+'<br><span class="muted">'+(l.book?esc(l.book)+' · ':'')+sname(l.stat)+(l.start?' · '+esc(fmt(l.start)):'')+' · </span><b>'+l.line+'</b>'+(g?'<span class="muted"> · proj '+g.proj+'</span>'+hitBoxes(g.hits):'<span class="muted"> · Can\'t grade this one. '+(rp(l)?'Research the player in the Players tab':'Research needed')+'</span>')+'</div><div style="text-align:right">'+(g?gradePill(g)+'<br>':'')+(g||!rp(l)?'<button class="g" data-act="lg" data-i="'+i+'">Grade</button> <button class="g" data-act="ladd" data-i="'+i+'">+ Slip</button>':'<button class="g" data-act="plview" data-p="'+esc(rp(l))+'">Research</button>')+(l.src==='manual'?' <button class="g" data-act="ldel" data-i="'+l.idx+'">✕</button>':'')+'</div></div>'}).join(''):'<div class="muted">No lines for this day yet. New lines appear as the books post them.</div>')+'</div>';
 h+='</div>';return h}
// ---- track record: every saved line is graded with stats from BEFORE its match date, then checked against the real result
var TS_CACHE={};
function teamSeries(team){var k=tn(team);if(TS_CACHE[k])return TS_CACHE[k];var by={};DB.forEach(function(p){if(!teq(p.team,team))return;combos(p).forEach(function(c){if(c.rounds!=null&&!by[c.mid])by[c.mid]={mid:c.mid,date:c.date,rounds:c.rounds}})});return TS_CACHE[k]=Object.keys(by).map(function(m){return by[m]}).sort(function(a,b){return a.date<b.date?1:a.date>b.date?-1:0})}
function avgRounds(team,before){var a=teamSeries(team).filter(function(x){return x.date<before}).slice(0,10);return a.length>=4?mean(a.map(function(x){return x.rounds})):null}
// rounds model: the player's kills (or headshots) per round over his last 10 Map 1+2 series x expected rounds for this matchup (average of both teams' recent Map 1+2 round totals)
function roundsProj(past,st,opp,team,date){var cs=combos(past).filter(function(c){return c.rounds&&c[st]!=null}).slice(0,10);if(cs.length<4)return null;var k=0,r=0;cs.forEach(function(c){k+=c[st];r+=c.rounds});var e1=avgRounds(team,date),e2=opp?avgRounds(opp,date):null;if(e1==null&&e2==null)return null;var E=e1==null?e2:e2==null?e1:(e1+e2)/2;return Math.round(k/r*E*10)/10}
// one pick per player/stat/day: a locked entry wins over an unlocked one (e.g. a second entry made when a book moved the start time); otherwise file order
function lockFirst(h){return h.map(function(e,i){return[e,i]}).sort(function(a,b){var la=a[0].lock&&a[0].lock.grade?0:1,lb=b[0].lock&&b[0].lock.grade?0:1;return la-lb||a[1]-b[1]}).map(function(x){return x[0]})}
function recordData(){TS_CACHE={};var rows=[],pending=0,nodata=0,seen={},pushes=0,voids=0;
 lockFirst(HIST||[]).forEach(function(e){var st=normStat(e.stat);if(!st||!e.start)return;var t=new Date(e.start).getTime();if(isNaN(t))return;
  if(t>NOW()-1*3600000){pending++;return}
  var rs=e.result||null;if(rs&&rs.outcome==='void'){voids++;return}
  if(isCombo(e.player)){ // combo: needs the locked pick, and every player's result for that match added up
   if(!(e.lock&&e.lock.grade)){nodata++;return}
   var d1=cday(e.start),k1=norm(e.player)+st+d1;if(seen[k1])return;var tot=0,okc=true;
   e.player.split('+').forEach(function(n){var pc=find(n.trim(),e.team),bc=null;if(!pc){okc=false;return}
    combos(pc).forEach(function(c){if(!c.date||!teq(c.opp,e.opponent))return;var dd=Math.abs((new Date(c.date+'T12:00:00Z')-new Date(d1+'T12:00:00Z'))/864e5);if(dd<=1&&(!bc||dd<bc.dd))bc={c:c,dd:dd}});
    if(!bc||bc.c[st]==null)okc=false;else tot+=bc.c[st]});
   if(!okc){nodata++;return}
   var lc=+e.lock.line;if(tot===lc){if(!seen[k1])pushes++;seen[k1]=1;return}seen[k1]=1;
   rows.push({team:e.team,opp:e.opponent,player:e.player,stat:st,line:lc,act:tot,pick:e.lock.pick,grade:oldG(e.lock),proj:e.lock.proj,locked:true,lat:e.lock.at||'',hit:e.lock.pick==='OVER'?tot>lc:tot<lc,start:e.start});return}
  var p=find(e.player,e.team);if(!p){nodata++;return}
  var d0=cday(e.start),key=norm(e.player)+st+d0;if(seen[key])return;
  var best=null;combos(p).forEach(function(c){if(!c.date||!teq(c.opp,e.opponent))return;var dd=Math.abs((new Date(c.date+'T12:00:00Z')-new Date(d0+'T12:00:00Z'))/864e5);if(dd<=1&&(!best||dd<best.dd))best={c:c,dd:dd}});
  if(!best||best.c[st]==null){nodata++;return}
  var past={name:p.name,team:p.team,logs:(p.logs||[]).filter(function(l){return l.date&&l.date<best.c.date})};
  var lk=e.lock&&e.lock.grade?e.lock:null; // locked in when the line was first seen: the exact grade, projection and pick the app gave then
  var line=lk?+lk.line:+e.line,g=lk?{grade:oldG(lk),proj:lk.proj,pick:lk.pick}:grade(p,st,line,e.opponent,{team:e.team,book:e.book,odds:e.odds,before:best.c.date});if(!g){nodata++;return}
  var act=best.c[st];if(act===line){pushes++;seen[key]=1;return}seen[key]=1;
  var pick=lk?lk.pick:(g.pick||((g.grade==='D'||g.grade==='F')?'UNDER':'OVER'));
  rows.push({team:e.team,opp:e.opponent,player:e.player,stat:st,line:line,act:act,rproj:roundsProj(past,st,e.opponent,p.team,best.c.date),pick:pick,grade:g.grade,proj:g.proj,locked:!!lk,lat:lk?(lk.at||''):'',hit:pick==='OVER'?act>line:act<line,model:lk?(lk.model||'v1'):'v2',pOver:lk?lk.p_over:g.pOver,start:e.start,bait:(combos(p).filter(function(c){return c.date<best.c.date&&c[st]!=null}).slice(0,5).filter(function(c){return c[st]>=line}).length===5)})});
 rows.forEach(function(r){r.day=cday(r.start)});rows.sort(function(a,b){return a.start<b.start?1:-1});return{rows:rows,pending:pending,nodata:nodata,pushes:pushes,voids:voids,total:(HIST||[]).length}}
function recordCard(){if(HIST==null)return '';var h='<div class="card" style="margin-top:12px"><h2>Track record</h2>';
 if(HIST==null)return h+'<div class="warn">No line history yet. It starts saving after the next "Update CS2 lines" run with the new script.</div></div>';
 var R=recordData(),rows=R.rows;
 if(!rows.length)return h+'<div class="muted">'+R.total+' lines saved so far. '+R.pending+' waiting for their matches to finish, '+R.nodata+' finished but not matched to results yet (player stats refresh once a day). The record fills in by itself.</div></div>';
 var dm={},dl=[];rows.forEach(function(r){if(!dm[r.day]){dm[r.day]=[];dl.push(r.day)}dm[r.day].push(r)});dl.sort().reverse();
 var D=sel.rd&&dm[sel.rd]?sel.rd:'all',vis=D==='all'?rows:dm[D];
 var hits=vis.filter(function(r){return r.hit}).length,err=vis.map(function(r){return r.proj-r.act});
 h+='<h2>By day</h2><div class="scroll"><table><tr><th>Date</th><th>Picks</th><th>Record</th><th>Hit rate</th><th></th></tr>'+dl.map(function(d){var r=dm[d],w=r.filter(function(x){return x.hit}).length;return '<tr'+(D===d?' style="outline:1px solid var(--green)"':'')+'><td>'+esc(dayLabel(d))+'</td><td>'+r.length+'</td><td>'+w+'-'+(r.length-w)+'</td><td>'+Math.round(w/r.length*100)+'%</td><td><button class="'+(D===d?'b':'g')+'" data-act="rday" data-d="'+d+'">View</button></td></tr>'}).join('')+'</table></div><div class="btns" style="margin:8px 0"><button class="'+(D==='all'?'b':'g')+'" data-act="rday" data-d="all">All days · '+rows.length+'</button></div>';
 h+='<h2 style="margin-top:8px">'+(D==='all'?'All days':esc(dayLabel(D)))+'</h2><div class="stats"><div class="st"><b>'+hits+'-'+(vis.length-hits)+'</b><span>Record ('+Math.round(hits/vis.length*100)+'%)</span></div><div class="st"><b>'+vis.length+'</b><span>Graded picks</span></div><div class="st"><b>'+fv(mean(err.map(Math.abs)))+'</b><span>Avg miss (kills/HS)</span></div><div class="st"><b>'+(mean(err)>=0?'+':'')+fv(mean(err))+'</b><span>Projection bias</span></div></div>';
 h+='<div class="scroll"><table><tr><th>Grade</th><th>Picks</th><th>Hit rate</th></tr>'+gradesIn(vis).map(function(G){var r=vis.filter(function(x){return x.grade===G}),hh=r.filter(function(x){return x.hit}).length;return '<tr><td>'+G+'</td><td>'+r.length+'</td><td>'+(r.length?Math.round(hh/r.length*100)+'% ('+hh+'-'+(r.length-hh)+')':'–')+'</td></tr>'}).join('')+'</table></div>';
 function wl(r){var w=r.filter(function(x){return x.hit}).length;return r.length?w+'-'+(r.length-w)+' ('+Math.round(w/r.length*100)+'%)':'–'}
 var sp=function(f){return vis.filter(f)};
 h+='<h2 style="margin-top:12px">Where picks win and lose</h2><div class="scroll"><table><tr><th>Grade</th><th>Kills</th><th>Headshots</th><th>Over</th><th>Under</th></tr>'+gradesIn(vis).map(function(G){return '<tr><td>'+G+'</td><td>'+wl(sp(function(x){return x.grade===G&&x.stat==='kills'}))+'</td><td>'+wl(sp(function(x){return x.grade===G&&x.stat==='hs'}))+'</td><td>'+wl(sp(function(x){return x.grade===G&&x.pick==='OVER'}))+'</td><td>'+wl(sp(function(x){return x.grade===G&&x.pick==='UNDER'}))+'</td></tr>'}).join('')+'<tr><td>All</td><td>'+wl(sp(function(x){return x.stat==='kills'}))+'</td><td>'+wl(sp(function(x){return x.stat==='hs'}))+'</td><td>'+wl(sp(function(x){return x.pick==='OVER'}))+'</td><td>'+wl(sp(function(x){return x.pick==='UNDER'}))+'</td></tr></table></div>';
 var bk=[[0,.05,'Under 5%'],[.05,.10,'5-10%'],[.10,.15,'10-15%'],[.15,.20,'15-20%'],[.20,.30,'20-30%'],[.30,9,'30%+']];
 h+='<h2 style="margin-top:12px">Hit rate by edge size</h2><div class="scroll"><table><tr><th>Projection vs line</th><th>Picks</th><th>Record</th></tr>'+bk.map(function(b){var r=sp(function(x){var e=Math.abs(x.proj-x.line)/x.line;return e>=b[0]&&e<b[1]});return '<tr><td>'+b[2]+'</td><td>'+r.length+'</td><td>'+wl(r)+'</td></tr>'}).join('')+'</table></div><div class="muted" style="margin-top:6px">Locked picks only: '+wl(sp(function(x){return x.locked}))+'. All picks: '+wl(vis)+'.</div>';
 // (the old 'shadow test' table applied a +4% Over shift and was removed with grader v2)
 function wls(a){var w=a.filter(function(x){return x}).length;return a.length?w+'-'+(a.length-w)+' ('+Math.round(w/a.length*100)+'%)':'–'}
 // ---- rounds model (shadow 2): per-round rate x expected rounds. Needs round counts in the data (saved by the daily update from now on).
 var rv=vis.filter(function(r){return r.rproj!=null&&r.proj!=null});
 function rt(r){var pc=(r.rproj-r.line)/r.line,m=Math.abs(pc),t=m>=.10?'Strong':m>=.06?'Good':m>=.03?'Lean':m>=.01?'Weak':'Toss-up',pk=pc>=0?'OVER':'UNDER';return{m:m,tier:t,pick:pk,hit:pk==='OVER'?r.act>r.line:r.act<r.line}}
 var rr=rv.map(function(r){return{r:r,q:rt(r)}});
 h+='<h2 style="margin-top:12px">Rounds model</h2>';
 if(rr.length<10)h+='<div class="muted">Only '+rr.length+' of '+vis.length+' picks have round data so far. Round counts are saved by the daily update and the results job (every 5 hours), so this fills in as new matches finish.</div>';
 else{var nR=Math.ceil(rr.length/3),tl=rr.slice().sort(function(a,b){return Math.abs((b.r.proj-b.r.line)/b.r.line)-Math.abs((a.r.proj-a.r.line)/a.r.line)}).slice(0,nR),tr=rr.slice().sort(function(a,b){return b.q.m-a.q.m}).slice(0,nR);
  var mae=function(f){return fv(mean(rr.map(function(x){return Math.abs(f(x.r)-x.r.act)})))},bias=function(f){var b=mean(rr.map(function(x){return f(x.r)-x.r.act}));return (b>=0?'+':'')+fv(b)};
  h+='<div class="muted" style="margin-bottom:6px">Projection = the player\'s kills (or headshots) per round over his last 10 Map 1+2 series, times the expected rounds for this matchup (the average of both teams\' recent Map 1+2 round totals). Only picks with enough round data ('+rr.length+' of '+vis.length+'). Live grades are untouched.</div><div class="scroll"><table><tr><th>Rounds tier</th><th>Picks</th><th>Record</th><th>Over / Under</th></tr>'+['Strong','Good','Lean','Weak','Toss-up'].map(function(T){var q=rr.filter(function(x){return x.q.tier===T});return '<tr><td>'+T+'</td><td>'+q.length+'</td><td>'+wls(q.map(function(x){return x.q.hit}))+'</td><td>'+q.filter(function(x){return x.q.pick==='OVER'}).length+' / '+q.filter(function(x){return x.q.pick==='UNDER'}).length+'</td></tr>'}).join('')+'</table></div>'
   +'<div class="scroll" style="margin-top:8px"><table><tr><th>Same '+rr.length+' picks</th><th>Most confident third</th><th>All picks</th><th>Avg miss</th><th>Bias</th></tr>'
   +'<tr><td>Live grader</td><td>'+wls(tl.map(function(x){return x.r.hit}))+'</td><td>'+wls(rr.map(function(x){return x.r.hit}))+'</td><td>'+mae(function(r){return r.proj})+'</td><td>'+bias(function(r){return r.proj})+'</td></tr>'
   +'<tr><td>Rounds model</td><td>'+wls(tr.map(function(x){return x.q.hit}))+'</td><td>'+wls(rr.map(function(x){return x.q.hit}))+'</td><td>'+mae(function(r){return r.rproj})+'</td><td>'+bias(function(r){return r.rproj})+'</td></tr>'
   +'<tr><td>Book line itself</td><td>–</td><td>–</td><td>'+mae(function(r){return r.line})+'</td><td>'+bias(function(r){return r.line})+'</td></tr>'
   +'<tr><td>Blend (line 50%, live 25%, rounds 25%)</td><td>–</td><td>–</td><td>'+mae(function(r){return .5*r.line+.25*r.proj+.25*r.rproj})+'</td><td>'+bias(function(r){return .5*r.line+.25*r.proj+.25*r.rproj})+'</td></tr></table></div><div class="muted" style="margin-top:6px">Avg miss is how far the projection is from the real result on average (smaller is better). Bias is projection minus result (0 is best). The Book line row is the benchmark: a projection only has an edge if its miss is smaller than the line\'s own miss.</div>'}
 // ---- over bias test: what if you had simply taken the Over on every graded line? Independent of any grade, projection or lock.
 function ob(r){var n=r.length,o=r.filter(function(x){return x.act>x.line}).length;if(!n)return['–','–','–'];var p=o/n,m=Math.round(196*Math.sqrt(p*(1-p)/n));return[n,o+'-'+(n-o),Math.round(p*100)+'% (±'+m+')']}
 var obRows=[['All picks',rows],['Kills',rows.filter(function(x){return x.stat==='kills'})],['Headshots',rows.filter(function(x){return x.stat==='hs'})],['Locked picks only',rows.filter(function(x){return x.locked})],['Line under 15',rows.filter(function(x){return x.line<15})],['Line 15-25',rows.filter(function(x){return x.line>=15&&x.line<25})],['Line 25 and up',rows.filter(function(x){return x.line>=25})]];
 dl.slice(0,10).forEach(function(d){obRows.push([dayLabel(d),dm[d]])});
 h+='<h2 style="margin-top:12px">Over bias test</h2><div class="muted" style="margin-bottom:6px">What if you had taken the Over on every graded line, ignoring the grader? Pushes are skipped. The number in brackets is the 95% margin of error: a result is only convincing if the whole range stays above the break-even rate of your slip type (usually about 54-58%). Picks from one match move together, so the true margin is wider than shown.</div><div class="scroll"><table><tr><th>Group</th><th>Lines</th><th>Overs hit</th><th>Over hit rate</th></tr>'+obRows.map(function(x){var q=ob(x[1]);return '<tr><td>'+esc(x[0])+'</td><td>'+q[0]+'</td><td>'+q[1]+'</td><td>'+q[2]+'</td></tr>'}).join('')+'</table></div>';
 // ---- by stat: does our projection carry real information for kills? for headshots? (slope 1 = all of our edge is real, 0 = none)
 var NEWG='2026-11-15T02:00:00';
 function bs(r){var n=r.length;if(!n)return['–','–','–','–','–','–'];var w=r.filter(function(x){return x.hit}).length,o=r.filter(function(x){return x.act>x.line}).length,pd=r.map(function(x){return x.proj-x.line}),ad=r.map(function(x){return x.act-x.line}),mp=pd.reduce(function(a,b){return a+b},0)/n,ma=ad.reduce(function(a,b){return a+b},0)/n,sx=0,sy=0;for(var i=0;i<n;i++){sx+=(pd[i]-mp)*(ad[i]-ma);sy+=(pd[i]-mp)*(pd[i]-mp)}
  return[n,w+'-'+(n-w)+' ('+Math.round(w/n*100)+'%)',Math.round(o/n*100)+'%',(mp>=0?'+':'')+mp.toFixed(1),(ma>=0?'+':'')+ma.toFixed(1),n>=15&&sy>0?(sx/sy).toFixed(2):'–']}
 var kR=rows.filter(function(x){return x.stat==='kills'&&x.proj!=null}),hR=rows.filter(function(x){return x.stat==='hs'&&x.proj!=null});
 function big(a){return a.filter(function(x){return (x.proj-x.line)/x.line>=.05})}
 function nw(a){return a.filter(function(x){return x.locked&&x.lat&&x.lat>=NEWG})}
 var bsRows=[['Kills, all',kR],['Kills, projected 5%+ over the line',big(kR)],['Kills, new grader picks only',nw(kR)],['Headshots, all',hR],['Headshots, projected 5%+ over the line',big(hR)],['Headshots, new grader picks only',nw(hR)]];
 h+='<h2 style="margin-top:12px">By stat: is our projection real?</h2><div class="muted" style="margin-bottom:6px">Hit rate is for the pick as graded. Over rate is how often the real result beat the line. Proj and Actual are the average distance from the line. Edge real is 1.00 if all of our projected edge shows up in real results and 0 or less if none of it does (needs 15+ picks). New grader picks are the ones locked since the shadow grader went live.</div><div class="scroll"><table><tr><th>Group</th><th>Picks</th><th>Hit rate</th><th>Over rate</th><th>Proj vs line</th><th>Actual vs line</th><th>Edge real</th></tr>'+bsRows.map(function(x){var q=bs(x[1]);return '<tr><td>'+esc(x[0])+'</td><td>'+q[0]+'</td><td>'+q[1]+'</td><td>'+q[2]+'</td><td>'+q[3]+'</td><td>'+q[4]+'</td><td>'+q[5]+'</td></tr>'}).join('')+'</table></div>';
 function av(a){return a.length?(mean(a)>=0?'+':'')+mean(a).toFixed(1):'–'}
 h+='<h2 style="margin-top:12px">Projection vs reality</h2><div class="scroll"><table><tr><th>Grade</th><th>Picks</th><th>Proj minus line</th><th>Actual minus line</th></tr>'+gradesIn(vis).map(function(G){var r=sp(function(x){return x.grade===G});return '<tr><td>'+G+'</td><td>'+r.length+'</td><td>'+av(r.map(function(x){return x.proj-x.line}))+'</td><td>'+av(r.map(function(x){return x.act-x.line}))+'</td></tr>'}).join('')+'</table></div><div class="muted" style="margin-top:6px">If a grade\'s projection sits above the line but the actual result sits below it (or the reverse), the projection is pointing the wrong way for that grade.</div>';
 var mm={},ml=[];vis.forEach(function(r){var k=[tn(r.team),tn(r.opp)].sort().join('|');if(!mm[k]){mm[k]={n:(r.team||'?')+' vs '+(r.opp||'?'),r:[]};ml.push(mm[k])}mm[k].r.push(r)});
 ml.sort(function(a,b){return b.r.length-a.r.length});
 h+='<h2 style="margin-top:12px">By match</h2><div class="scroll"><table><tr><th>Match</th><th>Picks</th><th>Record</th></tr>'+ml.slice(0,30).map(function(m){return '<tr><td>'+esc(m.n)+'</td><td>'+m.r.length+'</td><td>'+wl(m.r)+'</td></tr>'}).join('')+'</table></div>';
 h+='<h2 style="margin-top:12px">'+(D==='all'?'Latest results':'All picks that day')+'</h2>'+(D==='all'?vis.slice(0,15):vis).map(function(r){return '<div class="item"><div><b>'+esc(r.player)+'</b> <span class="muted">'+sname(r.stat)+' · '+r.pick+' '+r.line+' · got '+r.act+' · proj '+r.proj+(r.locked?' · locked':'')+'</span></div><div><span class="pill '+(r.hit?'':'u')+'">'+(r.hit?'HIT':'MISS')+' · '+r.grade+'</span>'+(r.bait?baitBadge(r):'')+'</div></div>'}).join('');
 return h+'<div class="muted" style="margin-top:8px">'+rows.filter(function(r){return r.locked}).length+' of '+rows.length+' picks are locked in: the exact line, grade, projection and pick the app gave when the line first appeared. Older ones were re-graded afterwards with stats from before their match. Pushes ('+R.pushes+') and voids ('+R.voids+', match not played or only one map) are left out of the hit rate. Grades A, B, C (Over) and D, F (Under) are grader v2; grades marked (old) were locked by the old grader and mean something else. '+R.pending+' pending, '+R.nodata+' not matched yet. Small samples mean little: wait for a few hundred picks before changing any weights.</div></div>'}
function opts(){var t={};DB.forEach(function(p){t[p.team]=1});return '<datalist id="plist">'+DB.map(function(p){return '<option value="'+esc(p.name)+'">'+esc(p.team)}).join('')+'</datalist><datalist id="tlist">'+Object.keys(t).sort().map(function(x){return '<option value="'+esc(x)+'">'}).join('')+'</datalist>'}
function viewGrader(){var combo=isCombo(sel.player),p=combo?{name:sel.player}:find(sel.player,sel.team),line=parseFloat(sel.line),g=p&&!isNaN(line)?gradeFor(sel.player,sel.team||'',sel.stat,line,sel.opp,{book:sel.book||'PrizePicks',odds:sel.odds}):null,miss='';if(sel.odds!=null&&sel.oddsLine==null)sel.oddsLine=String(line);if(g&&g.missing){miss=g.missing;g=null}
 var h='<div class="grid c2"><div class="card"><h2>Prop grader</h2><label>Player</label><input id="gp" list="plist" value="'+esc(sel.player)+'" placeholder="Start typing a player"><div class="row"><div><label>Stat</label><select id="gs"><option value="kills"'+(sel.stat==='kills'?' selected':'')+'>Kills Maps 1-2</option><option value="hs"'+(sel.stat==='hs'?' selected':'')+'>Headshots Maps 1-2</option></select></div><div><label>Line</label><input id="gl" type="number" step="0.5" value="'+esc(sel.line)+'"></div></div><label>Opponent</label><input id="go" list="tlist" value="'+esc(sel.opp)+'" placeholder="Team name"><label>Book (sets the break-even)</label><select id="gb">'+['PrizePicks','Underdog'].map(function(x){return '<option'+((sel.book||'PrizePicks')===x?' selected':'')+'>'+x+'</option>'}).join('')+'</select><div class="btns"><button class="b" data-act="grade">Grade it</button></div></div>';
 if(!sel.player)h+='<div class="card"><div class="warn">Pick a player and a line to grade.</div></div>';
 else if(!p)h+='<div class="card"><div class="warn">No player named "'+esc(sel.player)+'" in the data.</div></div>';
 else if(!g&&miss)h+='<div class="card"><div class="warn">Cannot grade this combo: no usable Maps 1-2 stats for '+esc(miss)+'. Every player in a combo needs stats.</div></div>';
 else if(!g)h+='<div class="card"><div class="warn">Not enough Maps 1-2 data for '+esc(p.name)+' yet (needs matches where both Map 1 and Map 2 were played) or the line is empty.</div></div>';
 else h+='<div>'+(window.GPCards?GPCards.html(g):'')+gradeCard(g)+'</div>';return h+'</div>'+opts()}
// ---- bar chart: real number on every bar, dashed line = the prop line, green over / red under
function chart(cs,st,line,n){var rows=cs.slice(0,n||10).filter(function(c){return c[st]!=null}).reverse();if(!rows.length)return '<div class="muted">No '+(st==='hs'?'headshot':'kill')+' data for this selection.</div>';
 var hasL=line!=null&&!isNaN(line),mx=Math.max.apply(null,rows.map(function(c){return c[st]}).concat([hasL?line:0,1]))*1.25;
 var cols=rows.map(function(c){var x=c[st],col=!hasL?'var(--green)':x>line?'var(--green)':x<line?'var(--red)':'#777';return '<div class="bc"><div class="bn">'+x+'</div><div class="bar" style="height:'+(x/mx*100)+'%;background:'+col+'"></div></div>'}).join('');
 var ds=rows.map(function(c){return '<div class="bd">'+esc(String(c.date||'').slice(5))+'</div>'}).join('');
 return '<div class="bars">'+(hasL?'<div class="ln" style="bottom:'+(line/mx*100)+'%"><span>'+line+'</span></div>':'')+cols+'</div><div class="bdates">'+ds+'</div>'}
function gradeCard(g){return '<div class="card"><div class="muted">'+esc(g.player)+' · '+esc(g.team)+(g.opp?' vs '+esc(g.opp):'')+' · '+sname(g.stat)+' · line '+g.line+'</div><div class="grade'+gclass(g.grade)+'">'+g.grade+'</div>'+baitBadge(g)+'<div><span class="pill '+(g.pick==='UNDER'?'u':'')+'">'+esc(g.label)+'</span></div>'+
 '<div class="stats"><div class="st"><b>'+g.over+'/'+g.of+'</b><span>Over, this season</span></div></div>'+
 (g.hits?'<h2 style="margin-top:12px">Hit rate vs '+g.line+'</h2>'+hitBoxes(g.hits)+'<div class="muted">Series (Maps 1-2) that went over this exact line: the last 5 / 10 / 15 / 20, vs '+esc(g.opp||'this opponent')+' this season, and the full season. Display only: the letter comes from the v1 projection versus the line, not from these hit rates. '+(GPModel.PARAMS.w_hr>0?'Blended into the chance at weight '+GPModel.PARAMS.w_hr+'.':'Shown for reference only: the backtest found it does not improve the grade, so it is not used in it.')+'</div>':'')+
 '<h2 style="margin-top:12px">Last 20 '+(g.stat==='hs'?'headshots':'kills')+' (Maps 1-2)</h2>'+chart(g.cs,g.stat,g.line,20)+'<div class="muted">Oldest to newest, with the date under each bar. The grade uses every series this season ('+g.of+'); the chart shows the latest 20. Dashed line = '+g.line+'. Green = over, red = under.</div>'+
 '<h2 style="margin-top:12px">Breakdown</h2><div class="scroll"><table class="comp-table"><tr><th>Part</th><th>Value</th><th>Series used</th></tr>'+g.comp.map(function(c){return '<tr><td>'+esc(c.k)+'</td><td class="comp-val">'+(c.txt!=null?esc(c.txt):c.v==null?'no data':c.v.toFixed(c.f==null?1:c.f)+(c.u||''))+'</td><td>'+(c.n==null?'':c.n)+'</td></tr>'}).join('')+'</table></div>'+
 '<div class="muted" style="margin-top:6px">'+esc(g.adj)+'. '+GRADE_LEGEND+' Role and map veto are not in the data.</div>'+
 '<div class="btns"><button class="b" data-act="gadd">Add to slip</button><button class="g" data-act="gimg">Download image</button><button class="g" data-act="gshare">Share</button></div>'+
 '<h2 style="margin-top:12px">Last 10 (Maps 1-2)</h2><div class="scroll"><table><tr><th>Date</th><th>Opp</th><th>Maps</th><th>'+(g.stat==='hs'?'HS':'Kills')+'</th></tr>'+g.cs.slice(0,10).map(function(c){return '<tr><td>'+esc(c.date)+'</td><td>'+esc(c.opp)+'</td><td>'+esc(c.maps)+'</td><td>'+(c[g.stat]==null?'':c[g.stat])+'</td></tr>'}).join('')+'</table></div></div>'}
// ---- auto slips: strong overs and strong unders, mixed
var svar='var',excl={};
function shuf(arr){if(svar!=='var')return arr;var t=arr.slice(0,10),r=arr.slice(10);for(var i=t.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),x=t[i];t[i]=t[j];t[j]=x}return t.concat(r)}
function buildSlip(n,mode){
 var best={};allLines().forEach(function(l){if(!l.g||!l.line||isCombo(l.player))return;var k=norm(l.player),e=l.g.edgePP;if(!best[k]||e>best[k].e)best[k]={l:l,e:e}});
 var all=Object.keys(best).map(function(k){var l=best[k].l;return{l:l,pct:(l.g.pick==='OVER'?1:-1)*(100+l.g.edgePP)/100,e:l.g.edgePP}}),skipNote='';
 var fresh=all.filter(function(x){return !excl[norm(x.l.player)]});if(Object.keys(excl).length){if(fresh.length>=n)all=fresh;else skipNote=' Not enough new players left, so skipped ones were allowed back.'}
 var ov=all.filter(function(x){return isPlay(x.l.g)&&x.l.g.pick==='OVER'}).sort(function(a,b){return b.pct-a.pct});
 var un=all.filter(function(x){return isPlay(x.l.g)&&x.l.g.pick==='UNDER'}).sort(function(a,b){return a.pct-b.pct});
 var upFirst=un.length&&(!ov.length||Math.abs(un[0].pct)>ov[0].pct);ov=shuf(ov);un=shuf(un);
 var used={},out=[];
 function take(arr,cnt){var t=0;for(var i=0;i<arr.length&&t<cnt;i++){var k=norm(arr[i].l.player);if(used[k])continue;used[k]=1;out.push(arr[i]);t++}return t}
 var both=shuf(ov.concat(un).sort(function(a,b){return Math.abs(b.pct)-Math.abs(a.pct)}));
 if(mode==='safe'){take(both,n)}
 else if(mode==='deg'){ // biggest edges overall, but force at least one of each side when both exist
  if(ov.length&&un.length){var bo=ov[0],bu=un[0];used[norm(bo.l.player)]=1;used[norm(bu.l.player)]=1;out.push(bo,bu)}
  take(both,n-out.length)}
 else{ // balanced: 2 of the side with the bigger top edge + the rest from the other (3 legs), or 2 and 2 (4 legs)
  var a1=ov,a2=un,n1=Math.ceil(n/2),n2=n-n1;
  if(upFirst){a1=un;a2=ov}
  take(a1,n1);take(a2,n2)}
 var short=n-out.length;
 if(short>0)take(both,short);
 if(out.length<n){ // still short: use the best remaining graded lines, any grade
  take(all.slice().sort(function(a,b){return Math.abs(b.pct)-Math.abs(a.pct)}),n-out.length)}
 var res=out.map(function(x){var g=x.l.g||{};return{player:x.l.player,team:x.l.team||g.team||'',opp:x.l.opp||x.l.opponent||g.opp||'',stat:x.l.stat,line:x.l.line,pick:g.pick,grade:g.grade,book:x.l.book||g.book||''}});
 var no=res.filter(function(x){return x.pick==='OVER'}).length,nu=res.length-no,weak=out.filter(function(x){return !isPlay(x.l.g)}).length;
 var msg='Built '+res.length+'-leg slip: '+no+' Over'+(no===1?'':'s')+', '+nu+' Under'+(nu===1?'':'s')+(res.length<n?' (only '+res.length+' lines available)':'');
 if(res.length&&(!(no&&nu)||weak)&&mode!=='safe')msg+=weak?'. Not enough plays (A, B, F without a flag), so '+weak+' weaker leg'+(weak===1?' was':'s were')+' added (below break-even or flagged)':'. Only one side had strong picks';
 return{out:res,msg:msg+skipNote}}
function viewSlip(){var h='<div class="grid c2"><div class="card"><h2>Slip builder</h2><div class="btns"><button class="g" data-act="auto" data-n="2" data-m="safe">Safe 2-Leg</button><button class="g" data-act="auto" data-n="3" data-m="bal">Balanced 3-Leg</button><button class="g" data-act="auto" data-n="4" data-m="bal">Balanced 4-Leg</button><button class="g" data-act="auto" data-n="4" data-m="deg">Degenerate 4-Leg</button></div><div class="btns" style="margin-top:8px"><button class="'+(svar==='var'?'b':'g')+'" data-act="svar" data-v="var">Variety</button><button class="'+(svar==='best'?'b':'g')+'" data-act="svar" data-v="best">Best edges</button><button class="g" data-act="sskip">Skip these players</button>'+(Object.keys(excl).length?'<button class="g" data-act="sskipclr">Reset skips ('+Object.keys(excl).length+')</button>':'')+'</div><div class="muted" style="margin-top:6px">Variety picks from the top 10 plays on each side, so every tap gives a new mix. Best edges always takes the biggest edges. Skip these players leaves the players on your current slip out of the next builds.</div><div class="muted" style="margin-top:6px">Auto slips use only plays: Overs graded A+ or B (projection at least 5% above the line) and Unders graded F (Under chance at least +3pp vs break-even, or a v1 projection more than 10% below the line that still passes that test), with no filter flag, one leg per player. When there are not enough plays the slip is filled with C / D legs and says so: those are below break-even. Safe 2-Leg takes the two biggest edges on either side. Balanced 3-Leg is 2 of one side and 1 of the other. Balanced 4-Leg is 2 Overs and 2 Unders. Degenerate 4-Leg takes the four biggest edges with at least one of each side. If a side runs short, the slip fills from the other side and says so.</div></div>';
 h+='<div class="card"><h2>Your slip · '+slip.length+' legs</h2>'+(slip.length?slip.map(function(s,i){return '<div class="item"><div><b>'+esc(s.player)+'</b> <span class="pill '+(s.pick==='UNDER'?'u':'')+'">'+s.pick+' '+s.line+'</span><br><span class="muted">'+sname(s.stat)+(s.grade?' · grade '+esc(s.grade):'')+'</span></div><button class="g" data-act="sdel" data-i="'+i+'">✕</button></div>'}).join('')+'<div class="btns"><button class="b" data-act="scopy">Copy</button><button class="g" data-act="spp">Open PrizePicks</button><button class="g" data-act="simg">Download cards</button><button class="g" data-act="sshare">Share cards</button><button class="g" data-act="sclear">Clear</button></div>':'<div class="muted">Empty. Add legs from Lines or Grader.</div>')+'</div></div>';return h}
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
 h+='<div class="row"><div><label>Sample</label><select id="pn">'+['5','10','15','all'].map(function(x){return '<option value="'+x+'"'+(x===n?' selected':'')+'>'+(x==='all'?'Full season':'Last '+x)+'</option>'}).join('')+'</select></div><div><label>Venue</label><select id="pv"><option value="all"'+(v==='all'?' selected':'')+'>All events</option><option value="lan"'+(v==='lan'?' selected':'')+'>LAN only</option><option value="online"'+(v==='online'?' selected':'')+'>Online only</option></select></div></div>';
 h+='<div class="row"><div><label>Opponent</label><select id="po"><option value="">Every team</option>'+Object.keys(opps).sort().map(function(t){return '<option'+(t===o?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div><div><label>Kills line</label><input id="pl1" type="number" step="0.5" value="'+esc(sel.l1||'')+'" placeholder="Maps 1-2"></div><div><label>HS line</label><input id="pl2" type="number" step="0.5" value="'+esc(sel.l2||'')+'" placeholder="Maps 1-2"></div></div>';
 if(!hasEv)h+='<div class="warn">LAN / online labels are not in the data yet. Run the "Update CS2 data" workflow with the new script and they will appear.</div>';
 if(!S.n){h+='<div class="warn">No matches with both Map 1 and Map 2 for this selection.</div></div>';return h}
 if(S.n<3)h+='<div class="warn">Small sample: only '+S.n+' series. Read the numbers with care.</div>';
 var ov=function(st,ln){if(isNaN(ln))return '';var vv=nums(cs,st);var c=vv.filter(function(x){return x>ln}).length;return '<div class="st"><b>'+c+'/'+vv.length+'</b><span>Over '+ln+' ('+Math.round(c/Math.max(vv.length,1)*100)+'%)</span></div>'};
 var hbr=function(st,ln,lab){if(isNaN(ln))return '';var r=GPModel.hitrates(mctx(),p,st,ln,o||'');return '<div class="muted" style="margin-top:6px">'+lab+' over '+ln+' (research: last 5 / 10 / 15 / this season'+(o?' / vs '+esc(o):'')+')</div>'+hitBoxes(r,o?['l5','l10','l15','szn','h2h']:['l5','l10','l15','szn'])};
 h+='<div class="stats"><div class="st"><b>'+S.n+'</b><span>Series ('+S.maps+' maps)</span></div><div class="st"><b>'+fv(S.kills)+'</b><span>Kills M1-2</span></div><div class="st"><b>'+fv(S.hs)+'</b><span>HS M1-2</span></div><div class="st"><b>'+fv(S.kpm)+'</b><span>Kills / map</span></div><div class="st"><b>'+fv(S.hsp,0)+'%</b><span>Headshot %</span></div><div class="st"><b>'+fv(S.kd,2)+'</b><span>K/D</span></div><div class="st"><b>'+fv(S.apm)+'</b><span>Assists / map</span></div><div class="st"><b>'+fv(S.adr,0)+'</b><span>ADR</span></div>'+ov('kills',l1)+ov('hs',l2)+'</div>'+hbr('kills',l1,'Kills')+hbr('hs',l2,'Headshots');
 var xs=Object.keys(S.x);if(xs.length)h+='<div class="stats">'+xs.map(function(k){return '<div class="st"><b>'+fv(S.x[k],2)+'</b><span>'+esc(k.replace(/_/g,' '))+' / map</span></div>'}).join('')+'</div>';
 else h+='<div class="muted">Clutches, first kills and shot accuracy appear here once bo3.gg returns them in the per-map rows. Check the Actions log line "players_stats keys".</div>';
  if(o){var hk=h2hSeasonRows(all,'kills',o),hh=h2hSeasonRows(all,'hs',o);
  h+='<h2 style="margin-top:12px">Breakdown · head-to-head this season vs '+esc(o)+'</h2><div class="scroll"><table class="comp-table"><tr><th>Part</th><th>Value</th><th>Series used</th></tr>'+
  hk.concat(hh).map(function(c,i){var lab=c.k+', '+(i<2?'kills':'headshots');return '<tr><td>'+esc(lab)+'</td><td class="comp-val">'+esc(c.txt)+'</td><td>'+(c.n||'')+'</td></tr>'}).join('')+
  '</table></div><div class="muted">Display only: this season\'s last 10 / last 15 Maps 1-2 meetings vs this opponent. If fewer meetings exist, those are used. Not an input to the grade. The venue filter above does not apply here.</div>';}
 var cn=Math.min(cs.length,15);h+='<h2 style="margin-top:12px">Last '+cn+' kills (Maps 1-2)</h2>'+chart(cs,'kills',l1,cn)+'<h2 style="margin-top:12px">Last '+cn+' headshots (Maps 1-2)</h2>'+chart(cs,'hs',l2,cn)+'<div class="muted">Follows the venue and opponent filters above. Type a kills or HS line to draw the dashed line and color the bars.</div>';
 h+='<h2 style="margin-top:12px">Series (Maps 1-2)</h2><div class="scroll"><table><tr><th>Date</th><th>Opp</th><th>Event</th><th>Maps</th><th>K</th><th>HS</th><th>D</th><th>A</th><th>ADR</th></tr>'+cs.map(function(c){return '<tr><td>'+esc(c.date)+'</td><td>'+esc(c.opp)+'</td><td>'+(c.ev?c.ev.toUpperCase():'–')+'</td><td>'+esc(c.maps)+'</td><td>'+c.kills+'</td><td>'+(c.hs==null?'–':c.hs)+'</td><td>'+(c.deaths==null?'–':c.deaths)+'</td><td>'+(c.assists==null?'–':c.assists)+'</td><td>'+fv(c.adr,0)+'</td></tr>'}).join('')+'</table></div>';
 // per-opponent breakdown (venue filter applies, sample size does not)
 var by={};base.forEach(function(c){(by[c.opp||'?']=by[c.opp||'?']||[]).push(c)});
 var rows=Object.keys(by).map(function(t){return{t:t,s:summ(by[t]),cs:by[t]}}).sort(function(a,b){return b.s.n-a.s.n||a.t.localeCompare(b.t)});
 h+='<h2 style="margin-top:14px">'+(v==='lan'?'LAN':v==='online'?'Online':'All events')+' vs every team · Maps 1-2</h2><div class="scroll"><table><tr><th>Opponent</th><th>Series</th><th>Kills</th><th>HS</th><th>HS%</th><th>K/D</th><th>ADR</th><th>Kills over</th><th>HS over</th></tr>'+rows.map(function(r){var k=nums(r.cs,'kills'),hh=nums(r.cs,'hs');return '<tr><td>'+esc(r.t)+'</td><td>'+r.s.n+(r.s.n<3?' ⚠':'')+'</td><td>'+fv(r.s.kills)+'</td><td>'+fv(r.s.hs)+'</td><td>'+fv(r.s.hsp,0)+'</td><td>'+fv(r.s.kd,2)+'</td><td>'+fv(r.s.adr,0)+'</td><td>'+(isNaN(l1)?'–':k.filter(function(x){return x>l1}).length+'/'+k.length)+'</td><td>'+(isNaN(l2)||!hh.length?'–':hh.filter(function(x){return x>l2}).length+'/'+hh.length)+'</td></tr>'}).join('')+'</table></div><div class="muted">⚠ = fewer than 3 series. Set the kills and HS lines above to fill the over columns.</div>';
 h+='<div class="btns"><button class="b" data-act="pgrade">Grade a line</button><button class="g" data-act="pclose">Back to list</button></div></div>';return h}
function viewPlayers(){if(sel.pl)return pcard()+opts();var q=(sel.q||'').toLowerCase(),tm=sel.tm||'';var teams={};DB.forEach(function(p){teams[p.team]=1});
 var list=DB.filter(function(p){return(!tm||p.team===tm)&&(p.name+p.team).toLowerCase().indexOf(q)>-1}).slice(0,200);
 return '<div class="card"><h2>Players · '+DB.length+' active</h2><div class="row"><input id="pq" placeholder="Search players or teams" value="'+esc(sel.q||'')+'"><select id="pt"><option value="">All teams</option>'+Object.keys(teams).sort().map(function(t){return '<option'+(t===tm?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div><div class="scroll"><table><tr><th>Player</th><th>Team</th><th>Kills M1-2</th><th>HS M1-2</th><th></th></tr>'+list.map(function(p){var cs=combos(p).slice(0,10);return '<tr><td>'+esc(p.name)+'</td><td>'+esc(p.team)+'</td><td>'+(cs.length?mean(nums(cs,'kills')).toFixed(1):'–')+'</td><td>'+(nums(cs,'hs').length?mean(nums(cs,'hs')).toFixed(1):'–')+'</td><td><button class="g" style="margin:0" data-act="plview" data-p="'+esc(p.name)+'">Stats</button></td></tr>'}).join('')+'</table></div><div class="muted">Averages are the last 10 series with both Map 1 and Map 2 played.</div></div>'}
// ---- Shadow grader (admin only): the last-10 grade saved next to the live one (shadow.py writes e.shadow before each match starts).
function viewShadow(){var rows=[],up=[],skip=0,voids=0,wait=0;
 (HIST||[]).forEach(function(e){var s=e.shadow;if(!s)return;if(s.skipped){skip++;return}
  var t=new Date(e.start).getTime();if(isNaN(t))return;var lk=e.lock&&e.lock.grade?e.lock:null,it={e:e,s:s,lk:lk,st:normStat(e.stat)};
  if(t>NOW()){up.push(it);return}
  var rs=e.result;if(rs&&rs.outcome==='void'){voids++;return}
  if(!rs||rs.act==null){wait++;return}
  var act=+rs.act,line=+s.line;if(act===line)return;
  it.act=act;it.hit=s.pick==='OVER'?act>line:act<line;it.lhit=lk&&act!==+lk.line?(lk.pick==='OVER'?act>+lk.line:act<+lk.line):null;it.day=cday(e.start);rows.push(it)});
 rows.sort(function(a,b){return a.e.start<b.e.start?1:-1});up.sort(function(a,b){return a.e.start<b.e.start?-1:1});
 function wl(a){var w=a.filter(function(x){return x}).length;return a.length?w+'-'+(a.length-w)+' ('+Math.round(w/a.length*100)+'%)':'–'}
 function inp(s){var p=s.pieces||{};function c(k,l){var x=p[k];return x&&x.n?l+' '+x.over+'/'+x.n+(x.mean!=null?' (avg '+x.mean+')':''):l+' –'}return [c('l10','Last 10'),c('h2h','Head to head'),c('szn','Season'),c('tier','Similar rank')].join(' · ')}
 function bk(s){var b=s.book;if(!b)return '';return '<br><span class="muted">Book: '+(b.first_line!=null&&+b.line!==+b.first_line?'line '+b.first_line+' → '+b.line:'line '+b.line+' (no move)')+(b.odds!=null?' · over odds '+b.odds:'')+(b.lean?' · leans '+b.lean:' · no lean')+(b.match_win!=null?' · match win '+Math.round(b.match_win*100)+'%':'')+'</span>'}
 var both=rows.filter(function(r){return r.lhit!=null});
 var h='<div class="card"><h2>Shadow grader · admin only</h2><div class="muted">Grades each prop from the last 10 series (average and over count), then pulls in head to head, season and similar-rank games with small weights. It is saved before the match starts and never changes. Compare its record with the live grader on the same props.</div></div>';
 h+='<div class="card" style="margin-top:12px"><div class="stats"><div class="st"><b>'+wl(rows.map(function(r){return r.hit}))+'</b><span>Shadow record ('+rows.length+' settled)</span></div><div class="st"><b>'+wl(both.map(function(r){return r.hit}))+'</b><span>Shadow, props with a live grade</span></div><div class="st"><b>'+wl(both.map(function(r){return r.lhit}))+'</b><span>Live grader, same props</span></div><div class="st"><b>'+up.length+'</b><span>Upcoming shadow picks</span></div></div>'+
  '<div class="muted" style="margin-top:6px">'+wait+' finished and waiting for results, '+skip+' skipped (under 5 earlier series or player not in the data)'+(voids?', '+voids+' void':'')+'. A few hundred settled props are needed before the gap between the two means anything.</div></div>';
 var bR=rows.filter(function(r){var b=r.e.shadow_b;return b&&!b.skipped&&+b.line!==r.act});
 bR.forEach(function(r){var b=r.e.shadow_b;r.bhit=b.pick==='OVER'?r.act>+b.line:r.act<+b.line});
 var bDis=bR.filter(function(r){return r.e.shadow_b.pick!==r.s.pick}),bUp=up.filter(function(r){var b=r.e.shadow_b;return b&&!b.skipped}).length;
 h+='<div class="card" style="margin-top:12px"><h2>Shadow B vs Shadow A</h2><div class="muted">Shadow B is the same recipe with head to head, season and similar-rank games allowed to pull much harder (caps 2 / 4 / 3 instead of 0.25). Saved before each match, never changed, scored on the same props as A. B only exists for props locked after it went live, so the sample starts small. Look at the props where the two disagree.</div><div class="stats" style="margin-top:8px"><div class="st"><b>'+wl(bR.map(function(r){return r.bhit}))+'</b><span>Shadow B ('+bR.length+' settled)</span></div><div class="st"><b>'+wl(bR.map(function(r){return r.hit}))+'</b><span>Shadow A, same props</span></div><div class="st"><b>'+wl(bDis.map(function(r){return r.bhit}))+'</b><span>B when it disagrees ('+bDis.length+')</span></div><div class="st"><b>'+wl(bDis.map(function(r){return r.hit}))+'</b><span>A on those props</span></div><div class="st"><b>'+bUp+'</b><span>Upcoming B picks</span></div></div></div>';
 if(rows.length){var dm={},dl=[];rows.forEach(function(r){if(!dm[r.day]){dm[r.day]=[];dl.push(r.day)}dm[r.day].push(r)});dl.sort().reverse();
  h+='<div class="card" style="margin-top:12px"><h2>By day</h2><div class="scroll"><table><tr><th>Date</th><th>Props</th><th>Shadow</th><th>Live (same props)</th></tr>'+dl.map(function(d){var r=dm[d],b=r.filter(function(x){return x.lhit!=null});return '<tr><td>'+esc(dayLabel(d))+'</td><td>'+r.length+'</td><td>'+wl(r.map(function(x){return x.hit}))+'</td><td>'+wl(b.map(function(x){return x.lhit}))+'</td></tr>'}).join('')+'</table></div>'+
  '<h2 style="margin-top:10px">Book lean vs shadow (logged only, not used in the pick)</h2><div class="scroll"><table><tr><th>Book lean</th><th>Props</th><th>Shadow record</th></tr>'+[['Agrees with shadow',function(r){return r.s.book&&r.s.book.lean&&r.s.book.lean===r.s.pick}],['Disagrees',function(r){return r.s.book&&r.s.book.lean&&r.s.book.lean!==r.s.pick}],['No lean',function(r){return !(r.s.book&&r.s.book.lean)}]].map(function(x){var r=rows.filter(x[1]);return '<tr><td>'+x[0]+'</td><td>'+r.length+'</td><td>'+wl(r.map(function(y){return y.hit}))+'</td></tr>'}).join('')+'</table></div>'+
  '<h2 style="margin-top:10px">By shadow letter</h2><div class="scroll"><table><tr><th>Letter</th><th>Props</th><th>Record</th><th>Kills</th><th>Headshots</th></tr>'+['A+','B','C','D','F'].map(function(G){var r=rows.filter(function(x){return x.s.grade===G});return r.length?'<tr><td>'+G+'</td><td>'+r.length+'</td><td>'+wl(r.map(function(x){return x.hit}))+'</td><td>'+wl(r.filter(function(x){return x.st==='kills'}).map(function(x){return x.hit}))+'</td><td>'+wl(r.filter(function(x){return x.st==='hs'}).map(function(x){return x.hit}))+'</td></tr>':''}).join('')+'</table></div></div>'}
 function card(it,done){var e=it.e,s=it.s,lk=it.lk;return '<div class="item"><div><b>'+esc(e.player)+'</b> <span class="muted">'+esc(e.team)+(e.opponent?' vs '+esc(e.opponent):'')+'</span><br><span class="muted">'+(e.book?esc(e.book)+' · ':'')+sname(it.st)+' · '+esc(fmt(e.start))+' · line </span><b>'+s.line+'</b><br>'+
  '<span class="muted">Shadow: </span><b>'+esc(s.pick)+' '+esc(s.grade)+'</b><span class="muted"> · proj '+s.proj+' · live: </span><b>'+(lk?esc(lk.pick)+' '+esc(oldG(lk))+'</b><span class="muted"> · proj '+lk.proj+(lk.pick===s.pick?' · agree':' · differ')+'</span>':'–</b>')+
  '<br><span class="muted">'+inp(s)+'</span>'+bk(s)+'</div>'+(done?'<div><span class="pill" style="'+(it.hit?'':'opacity:.55')+'">'+(it.hit?'WIN':'LOSS')+'</span><div class="muted">'+it.act+(it.lhit==null?'':' · live '+(it.lhit?'win':'loss'))+'</div></div>':'')+'</div>'}
 h+='<div class="card" style="margin-top:12px"><h2>Upcoming shadow picks · '+up.length+'</h2>'+(up.length?up.slice(0,150).map(function(it){return card(it,false)}).join('')+(up.length>150?'<div class="muted">Showing the first 150.</div>':''):'<div class="muted">None yet. Shadow picks are saved at the next hourly lines run after shadow.py and fetch_lines.py are uploaded, for props that have not started.</div>')+'</div>';
 h+='<div class="card" style="margin-top:12px"><h2>Settled shadow picks · '+rows.length+'</h2>'+(rows.length?rows.slice(0,80).map(function(it){return card(it,true)}).join('')+(rows.length>80?'<div class="muted">Showing the latest 80.</div>':''):'<div class="muted">Nothing settled yet. Results fill in by themselves after the matches finish.</div>')+'</div>';
 return h}
function render(){if(tab==='shadow'&&!shadowOK())tab='dash';nav();chips();var v={dash:viewDash,games:viewGames,lines:viewLines,grader:viewGrader,slip:viewSlip,players:viewPlayers,shadow:viewShadow}[tab]();$('main').innerHTML=v+(tab==='lines'?opts():'')}
function go(t){gpClose();tab=t;render();window.scrollTo(0,0)}
// ---- images (grade + translucent logo only). Font: Russo One (bold, sporty), loaded from Google Fonts; falls back to Impact.
var IMGFONT='"Russo One",Impact,"Arial Black",sans-serif';
(function(){try{var l=document.createElement('link');l.rel='stylesheet';l.href='https://fonts.googleapis.com/css2?family=Russo+One&display=swap';document.head.appendChild(l)}catch(e){}})();
function fontReady(cb){var done=false;function go(){if(!done){done=true;cb()}}setTimeout(go,1500);try{document.fonts.load('60px "Russo One"').then(go,go)}catch(e){go()}}
function img(kind,cb){fontReady(function(){var c=document.createElement('canvas');c.width=1080;c.height=1350;var x=c.getContext('2d');x.fillStyle='#0a0a0a';x.fillRect(0,0,1080,1350);x.strokeStyle='#00FF66';x.lineWidth=10;x.strokeRect(24,24,1032,1302);
 var im=new Image();im.onload=function(){x.globalAlpha=.12;var w=760,h=w*im.height/im.width;x.drawImage(im,(1080-w)/2,(1350-h)/2,w,h);x.globalAlpha=1;draw();cb(c)};im.onerror=function(){draw();cb(c)};im.src='assets/logo.png';
 function T(t,y,size,color,glow,maxW){x.font=size+'px '+IMGFONT;while(maxW&&size>20&&x.measureText(t).width>maxW){size-=2;x.font=size+'px '+IMGFONT}
  x.shadowColor=glow||'transparent';x.shadowBlur=glow?28:0;x.fillStyle=color;x.fillText(t,540,y);x.shadowBlur=0}
 function draw(){x.textAlign='center';if(kind.g){var g=kind.g,gc=g.grade==='A+'||g.grade==='A'||g.grade==='B'||g.grade==='F'?'#00FF66':g.grade==='C'||g.grade==='D'?'#ffc53d':'#ff4d6d';
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
function curGrade(){var g=gradeFor(sel.player,sel.team||'',sel.stat,parseFloat(sel.line),sel.opp,{book:sel.book||'PrizePicks',odds:sel.odds});return g&&!g.missing?g:null}
function addSlip(g){if(slip.some(function(s){return norm(s.player)===norm(g.player)&&s.stat===g.stat})){toast('Already on slip');return}slip.push({player:g.player,team:g.team||'',opp:g.opp||'',stat:g.stat,line:g.line,pick:g.pick,grade:g.grade,book:g.book||''});save('gp_slip',slip);toast('Added '+g.player+' '+g.pick+' '+g.line)}
function slipGrade(s){var team=s.team||'',p=find(s.player,team);return gradeFor(s.player,team||(p&&p.team)||'',s.stat,parseFloat(s.line),s.opp||'',{book:s.book||'PrizePicks'})}
function exportSlipCards(){if(!window.GPCards){toast('Cards are not loaded');return}var i=0,out=[];
 function next(){if(i>=slip.length){if(!out.length){toast('Could not build slip cards');return}showCards(out);return}
  var s=slip[i++],g=slipGrade(s);if(!g||g.missing){next();return}
  GPCards.img(g,function(c){out.push({c:c,name:'glocky-card-'+(s.player||'player').replace(/[^A-Za-z0-9]+/g,'-')+'.png'});next()})}
 next()}
function showCards(items){if(items.length===1){dl(items[0].c,items[0].name);return}
 var old=document.getElementById('imgov');if(old)old.remove();
 var ov=document.createElement('div');ov.id='imgov';ov.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;z-index:100;background:rgba(0,0,0,.96);overflow:auto;-webkit-overflow-scrolling:touch;padding:16px;text-align:center';
 var hint=document.createElement('div');hint.textContent='One trading card per slip prop. Press and hold a card to save it.';hint.style.cssText='color:#c8cdd2;font:600 14px system-ui;margin-bottom:12px';
 ov.appendChild(hint);
 var files=[],urls=[];
 function btn(t,green){var b=document.createElement('button');b.textContent=t;b.style.cssText='font:800 15px system-ui;padding:13px 22px;border-radius:12px;border:1px solid #00FF66;cursor:pointer;margin:4px;'+(green?'background:#00FF66;color:#000':'background:#111;color:#00FF66');return b}
 var pending=items.length;
 items.forEach(function(it,i){it.c.toBlob(function(b){var url=URL.createObjectURL(b);urls.push(url);var im=document.createElement('img');im.src=url;im.alt=it.name;im.style.cssText='display:block;margin:0 auto 14px;max-width:min(360px,92%);border-radius:12px';ov.insertBefore(im,ov.children[1]||null);
  try{files.push(new File([b],it.name,{type:'image/png'}))}catch(e){}
  if(--pending===0){var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;justify-content:center;flex-wrap:wrap;padding:8px 0 24px;position:sticky;bottom:0;background:linear-gradient(#0000,#000 30%)';
   if(files.length&&navigator.canShare&&navigator.canShare({files:files})){var sb=btn('Share all',true);sb.onclick=function(){navigator.share({files:files}).then(function(){toast('Shared')}).catch(function(){})};row.appendChild(sb)}
   var db=btn('Download all',!row.children.length);db.onclick=function(){items.forEach(function(it2,j){var a=document.createElement('a');a.href=urls[j];a.download=it2.name;document.body.appendChild(a);a.click();a.remove()});toast('If nothing saved, press and hold a card')};row.appendChild(db);
   var cb=btn('Close',false);cb.onclick=function(){ov.remove();urls.forEach(function(u){setTimeout(function(){URL.revokeObjectURL(u)},500)})};row.appendChild(cb);
   ov.appendChild(row)}},'image/png')});
 document.body.appendChild(ov)}
function rp(l){if(l.g||String(l.player||'').indexOf('+')>=0)return '';var p=find(l.player,l.team);return p?p.name:''}
function openP(n){gpClose();sel.pl=n;sel.v='all';sel.o='';var r=recents().filter(function(x){return x!==n});r.unshift(n);save('gp_recent',r.slice(0,8));tab='players';render();window.scrollTo(0,0);toast('Stats for '+n)}
// ---- game props side panel: tap See props on a game and that match's lines slide in on the right
function gpClose(){var p=document.getElementById('gpanel');if(p){p.classList.remove('open');setTimeout(function(){var q=document.getElementById('gpanel');if(q&&!q.classList.contains('open'))q.remove()},250)}}
function gpItem(a){var l=a[0],i=a[1],g=l.g,started=l.start&&new Date(l.start).getTime()<NOW();
 return '<div class="item"><div><b>'+esc(l.player)+'</b> <span class="muted">'+esc(sname(l.stat))+(l.book?' · '+esc(l.book):'')+(started?' · started':'')+'</span><br><span class="muted">line </span><b>'+l.line+'</b>'+(g?'<span class="muted"> · proj '+g.proj+' · over '+g.over+'/'+g.of+'</span>':'<span class="muted"> · can\'t grade this one'+(rp(l)?', research him in the Players tab':'')+'</span>')+'</div><div style="text-align:right">'+(g?gradePill(g)+'<br><button class="g" data-act="lg" data-i="'+i+'">Grade</button> <button class="g" data-act="ladd" data-i="'+i+'">+ Slip</button>':(rp(l)?'<button class="g" data-act="plview" data-p="'+esc(rp(l))+'">Research</button>':'<button class="g" data-act="lg" data-i="'+i+'">Grade</button>'))+'</div></div>'}
function openGP(id){var g=null;GAMES.forEach(function(x){if(String(x.id)===String(id))g=x});if(!g){toast('Game not found');return}
 var all=allLines(),mine=[];all.forEach(function(l,i){if(teq(l.team,g.team1)||teq(l.team,g.team2))mine.push([l,i])});
 function side(t){return mine.filter(function(a){return teq(a[0].team,t)}).sort(function(a,b){return a[0].player.toLowerCase()<b[0].player.toLowerCase()?-1:a[0].player.toLowerCase()>b[0].player.toLowerCase()?1:(a[0].stat<b[0].stat?-1:1)})}
 var s1=side(g.team1),s2=side(g.team2),gr=mine.filter(function(a){return a[0].g}).length;
 var body='<div class="muted">'+esc(g.tournament||'')+' · '+esc(fmt(g.start))+(g.bo?' · Bo'+esc(g.bo):'')+'</div><div class="big" style="margin:4px 0 2px">'+esc(g.team1)+' <span class="vs">vs</span> '+esc(g.team2)+'</div><div class="muted" style="margin-bottom:8px">'+(isUp(g)?mine.length+' props · '+gr+' graded · Maps 1-2':'')+'</div>';
 var started=!isUp(g);
 if(started){body+='<div class="warn" style="margin-top:10px">'+(g.status==='finished'?'This game is finished, so props are closed.':'This game is already live, so props are closed.')+'</div>'}
 else if(!mine.length)body+='<div class="warn">No props posted for this match yet. PrizePicks and Underdog usually post a few hours before the start, and this list updates about every hour.</div>';
 else body+=[[g.team1,s1],[g.team2,s2]].map(function(t){return '<h2 style="margin-top:12px">'+esc(t[0])+(rankOf(t[0])?' #'+rankOf(t[0]):'')+' · '+t[1].length+'</h2>'+(t[1].length?t[1].map(gpItem).join(''):'<div class="muted">No props for this team yet.</div>')}).join('');
 var old=document.getElementById('gpanel');if(old)old.remove();
 var el=document.createElement('div');el.id='gpanel';el.innerHTML='<div class="gp-bg" data-act="gpclose"></div><aside class="gp-panel" role="dialog" aria-label="Props for this game"><div class="gp-head"><b>Props</b><button class="g gp-x" data-act="gpclose" aria-label="Close">✕</button></div><div class="gp-body">'+body+'</div></aside>';
 document.body.appendChild(el);void el.offsetWidth;el.classList.add('open')}
document.addEventListener('keydown',function(e){if(e.key==='Escape')gpClose()});
// ---- actions
document.addEventListener('click',function(e){var b=e.target.closest('[data-act],[data-t]');if(!b)return;
 if(b.dataset.t&&!b.dataset.act){go(b.dataset.t);return}
 var a=b.dataset.act,i=+b.dataset.i;
 if(a==='go')go(b.dataset.t);
 else if(a==='reload'){toast('Reloading…');boot()}
 else if(a==='gsub'){sel.gv=b.dataset.v;render();pollLive(true)}
 else if(a==='watch'){var id=b.dataset.i,si=+b.dataset.s;if(sel.watch&&String(sel.watch.id)===String(id)&&+sel.watch.s===si)sel.watch=null;else sel.watch={id:id,s:si};render()}
 else if(a==='lday'){sel.ld=b.dataset.d;render()}
 else if(a==='lbook'){sel.lb=b.dataset.b;render()}
 else if(a==='rday'){sel.rd=b.dataset.d;render()}
 else if(a==='gamegrade'){openGP(b.dataset.i)}
 else if(a==='gpclose'){gpClose()}
 else if(a==='dsearch'){var nm=($('ds').value||'').trim(),pp=find(nm);if(!pp){toast('No player named "'+nm+'"');return}openP(pp.name)}
 else if(a==='plview'){openP(b.dataset.p)}
 else if(a==='rclear'){save('gp_recent',[]);render();toast('Search history cleared')}
 else if(a==='gameopen'){toast('Search a player to see his stats')}
 else if(a==='pclose'){sel.pl='';render();toast('Back to list')}
 else if(a==='pgrade'){var pp2=find(sel.pl);sel.player=pp2.name;sel.line=sel.stat==='hs'?(sel.l2||''):(sel.l1||'');sel.opp=sel.o||'';go('grader');toast('Loaded '+pp2.name+' in the grader')}
 else if(a==='pg'){sel.player=b.dataset.p;var p=find(sel.player);sel.opp='';go('grader');toast('Loaded '+sel.player+'. Enter a line')}
 else if(a==='grade'){var np=$('gp').value;if(np!==sel.player)sel.team='';sel.player=np;sel.stat=$('gs').value;sel.line=$('gl').value;sel.opp=$('go').value;var nb=$('gb')?$('gb').value:'PrizePicks';if(nb!==sel.book||String(parseFloat(sel.line))!==String(sel.oddsLine))sel.odds=null;sel.book=nb;render();toast('Graded')}
 else if(a==='gadd'){var g=curGrade();if(g)addSlip(g)}
 else if(a==='gimg'){var g2=curGrade();if(g2)(window.GPCards?GPCards.img:function(g,f){img({g:g},f)})(g2,function(c){dl(c,'glocky-card.png')})}
 else if(a==='gshare'){var g3=curGrade();if(g3)(window.GPCards?GPCards.img:function(g,f){img({g:g},f)})(g3,function(c){share(c,'glocky-card.png')})}
 else if(a==='madd'){var n=$('mp').value.trim(),l=parseFloat($('ml').value);if(!n||isNaN(l)){toast('Enter a player and a line');return}var p2=find(n);manual.push({player:p2?p2.name:n,team:p2?p2.team:'',stat:$('ms').value,line:l,opponent:$('mo').value,period:'Maps 1-2',src:'manual'});save('gp_manual',manual);render();toast('Line saved')}
 else if(a==='ldel'){manual.splice(i-LINES.length,1);save('gp_manual',manual);render();toast('Line removed')}
 else if(a==='lg'){var l2=allLines()[i];sel={player:l2.player,stat:l2.stat,line:String(l2.line),opp:l2.opp,team:l2.team,book:l2.book||'PrizePicks',odds:l2.odds,oddsLine:String(+l2.line)};go('grader');toast('Loaded '+l2.player)}
 else if(a==='ladd'){var l3=allLines()[i];if(!l3.g){toast('Can\'t grade this one. Research the player in the Players tab');return}addSlip(l3.g);render()}
 else if(a==='auto'){var r=buildSlip(+b.dataset.n,b.dataset.m||'bal');if(!r.out.length){toast('No graded lines yet. Add lines first');return}slip=r.out;save('gp_slip',slip);render();toast(r.msg)}
 else if(a==='svar'){svar=b.dataset.v;render();toast(svar==='var'?'Variety on: each build is a new mix':'Best edges: always the biggest edges')}
 else if(a==='sskip'){if(!slip.length){toast('Build a slip first');return}slip.forEach(function(x){excl[norm(x.player)]=1});slip=[];save('gp_slip',slip);render();toast('Skipping those players. Build again')}
 else if(a==='sskipclr'){excl={};render();toast('Skips cleared')}
 else if(a==='sdel'){slip.splice(i,1);save('gp_slip',slip);render();toast('Removed')}
 else if(a==='sclear'){slip=[];save('gp_slip',slip);render();toast('Slip cleared')}
 else if(a==='scopy'){var t=slip.map(function(s){return s.player+' '+sname(s.stat)+' '+s.pick+' '+s.line}).join('\n');(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){toast('Copied')}).catch(function(){toast('Copy not allowed here')})}
 else if(a==='spp'){window.open('https://app.prizepicks.com','_blank','noopener');toast('Opening PrizePicks. Enter your picks there')}
 else if(a==='simg'||a==='sshare'){if(!slip.length){toast('Slip is empty');return}exportSlipCards()}
});
document.addEventListener('input',function(e){if(e.target.id==='pq'){sel.q=e.target.value;var pos=e.target.selectionStart;render();var n=$('pq');n.focus();n.setSelectionRange(pos,pos)}});
document.addEventListener('change',function(e){var i=e.target.id,m={pt:'tm',pn:'n',pv:'v',po:'o',pl1:'l1',pl2:'l2'};if(m[i]){sel[m[i]]=e.target.value;render();toast('Updated')}});
// ---- data
// admin key: open the site once as  /#admin=YOURKEY  to unlock the Track record on this device ( #admin=off removes it )
(function(){try{var m=/admin=([^&]*)/.exec(location.hash||'');if(m){var k=decodeURIComponent(m[1]);if(k==='off')localStorage.removeItem('gp_admin');else localStorage.setItem('gp_admin',k);history.replaceState(null,'',location.pathname+location.search)}}catch(e){}})();
function adminKey(){try{return localStorage.getItem('gp_admin')||''}catch(e){return ''}}
function getJSON(u){var o={};if(u==='lines_history.json'&&adminKey())o={headers:{'X-Admin-Key':adminKey()}};return fetch(u+'?'+Date.now(),o).then(function(r){if(r.status===401&&u!=='lines_history.json'){location.href='/login?next='+encodeURIComponent(location.pathname);throw 0}if(!r.ok)throw 0;return r.json()})}
var FEED_V=0;function applyFeeds(g,l,h,p){FEED_V++;
 if(g){GAMES=(g.games||[]).filter(function(x){return x.start}).sort(function(a,b){return a.start<b.start?-1:1});META.games_iso=g.updated||'';META.games_at=(g.updated&&g.updated.indexOf('T')>-1)?fmt(g.updated):(g.updated||'')}
 if(l){LINES=l.lines||[];META.lines_at=l.observed_at?fmt(l.observed_at):''}
 if(h&&h.entries)HIST=h.entries;if(p&&p.entries)PREG=p.entries}
function feeds(){return Promise.all([getJSON('games.json').catch(function(){return null}),getJSON('lines.json').catch(function(){return null}),getJSON('lines_history.json').catch(function(){return null}),HIST?Promise.resolve(null):getJSON('pregame.json').catch(function(){return null})])}
function boot(){Promise.all([getJSON('players.json'),feeds(),getJSON('team_strength.json').catch(function(){return null})]).then(function(r){
 STRENGTH=r[2]||null;MCTX=null;r[0]=GPModel.decodePlayers(r[0])||{};DB=r[0].players||[];RANK=r[0].ranks||{};META.updated=r[0].updated||'';applyFeeds(r[1][0],r[1][1],r[1][2],r[1][3]);render();
 }).catch(function(){$('main').innerHTML='<div class="card"><div class="warn">Could not load players.json. Open this from the hosted site.</div></div>';nav()})}
setInterval(function(){if(document.hidden||!DB.length)return;var ae=document.activeElement;if(ae&&/INPUT|SELECT|TEXTAREA/.test(ae.tagName))return;if(['games','lines','dash'].indexOf(tab)<0)return;
 feeds().then(function(r){applyFeeds(r[0],r[1],r[2],r[3]);if(!document.getElementById('imgov'))render();if(tab==='games')pollLive(true)})},60000);
// ---- AI chat: answers only from the app's own numbers. The page builds a small facts sheet; the Cloudflare Worker adds the key.
var chatLog=[],chatBusy=false;
function f1(x,d){return x==null||isNaN(x)?'n/a':x.toFixed(d==null?1:d)}
function aiPlayerFacts(p){var all=combos(p),l10=all.slice(0,10),S=summ(l10),A=summ(all);
 var t=p.name+' ('+p.team+(rankOf(p.team)?', team rank #'+rankOf(p.team):'')+'): '+all.length+' series logged with both Map 1 and Map 2.\n';
 t+='Last '+l10.length+' series, Maps 1-2: avg kills '+f1(S.kills)+', avg headshots '+f1(S.hs)+', kills per map '+f1(S.kpm)+', headshot % '+f1(S.hsp,0)+', K/D '+f1(S.kd,2)+', assists per map '+f1(S.apm)+', ADR '+f1(S.adr,0)+'.\n';
 t+='All logged ('+all.length+' series): avg kills '+f1(A.kills)+', avg headshots '+f1(A.hs)+', kills per map '+f1(A.kpm)+', headshot % '+f1(A.hsp,0)+', K/D '+f1(A.kd,2)+', ADR '+f1(A.adr,0)+'.\n';
 t+='Last 10 series (date, opponent, kills, headshots): '+l10.map(function(c){return c.date+' vs '+c.opp+' '+c.kills+'k '+(c.hs==null?'?':c.hs)+'hs'}).join('; ')+'\n';
 var ls=allLines().filter(function(l){return l.g&&!isCombo(l.player)&&find(l.player,l.team)===p});
 if(ls.length)t+='Current lines: '+ls.map(function(l){return sname(l.stat)+' '+(l.book?l.book+' ':'')+l.line+' vs '+(l.opp||'?')+' -> projection '+l.g.proj+', grade '+l.g.grade+', pick '+l.g.pick+', over '+l.g.over+'/'+l.g.of+' recently'}).join('; ')+'\n';
 return t}
function aiFacts(q){var seen={},picks=[],toks=String(q).split(/[^A-Za-z0-9_.\-]+/).filter(Boolean);
 toks.forEach(function(w){var n=norm(w);if(n.length<2||seen[n])return;seen[n]=1;var p=find(w,'');if(p&&picks.indexOf(p)<0)picks.push(p)});
 if(!picks.length){var cur=tab==='players'&&sel.pl?find(sel.pl):tab==='grader'&&sel.player?find(sel.player,sel.team):null;if(cur)picks.push(cur)}
 picks=picks.slice(0,3);
 var t='';if(!picks.length)t+='No player in the question matched the data.\n';
 picks.forEach(function(p){t+=aiPlayerFacts(p)+'\n'});
 t+='Grader method: projection = 35% last 10 series, 20% all logged, 20% head-to-head vs the opponent, 15% vs teams of a similar rank tier, 10% last 3 series, then a small form adjustment from ADR (capped at 5%). Grade A+ = projection 15%+ above the line, B = 5-15% above, C = within about 2% below to 5% above, D = 2-10% below, F = more than 10% below. If the pick is Under and the letter is D or F, F is kept only when P(under) is at least +3pp over the book break-even; otherwise it is D.\n';
 return t}
function chatUI(){if($('aibtn'))return;
 var b=document.createElement('button');b.id='aibtn';b.type='button';b.textContent='Ask AI';document.body.appendChild(b);
 var p=document.createElement('div');p.id='aipanel';p.className='hide';
 p.innerHTML='<div class="aih"><b>Ask the AI</b><button type="button" id="aix" aria-label="Close">✕</button></div><div id="aimsgs"></div><div class="aif"><input id="aiq" placeholder="e.g. What is donk\'s headshot %?" maxlength="300"><button type="button" id="ais">Send</button></div>';
 document.body.appendChild(p);
 function show(){p.classList.toggle('hide');if(!p.classList.contains('hide')){if(!chatLog.length)addMsg('a','Ask me about any player in the app: headshot %, K/D, last 10 kills against a line, or what a grade means. I only answer from the app\'s own data.');$('aiq').focus()}}
 b.onclick=show;$('aix').onclick=show;
 $('ais').onclick=send;$('aiq').addEventListener('keydown',function(e){if(e.key==='Enter')send()})}
function addMsg(who,text){var d=document.createElement('div');d.className='aim '+who;d.textContent=text;var m=$('aimsgs');m.appendChild(d);m.scrollTop=m.scrollHeight;return d}
function send(){if(chatBusy)return;var inp=$('aiq'),q=(inp.value||'').trim();if(!q)return;inp.value='';addMsg('u',q);
 var url=window.GP_AI_URL||'';if(!url){addMsg('a','The AI is not connected yet. Add the server address to config.js.');return}
 chatBusy=true;var wait=addMsg('a','Thinking...');
 var hist=chatLog.slice(-6);
 fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,facts:aiFacts(q),history:hist})})
  .then(function(r){return r.json().catch(function(){return{}}).then(function(d){return{ok:r.ok,d:d}})})
  .then(function(x){var a=x.ok&&x.d.answer?x.d.answer:(x.d.error||'Something went wrong. Try again.');wait.textContent=a;if(x.ok&&x.d.answer){chatLog.push({role:'user',content:q},{role:'assistant',content:a})}})
  .catch(function(){wait.textContent='Could not reach the AI. Check your connection and try again.'})
  .then(function(){chatBusy=false;var m=$('aimsgs');m.scrollTop=m.scrollHeight})}
nav();boot();chatUI();
document.addEventListener('gp-photos',function(){if(tab==='grader')render()});
})();

