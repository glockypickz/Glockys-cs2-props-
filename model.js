/* Grader v2 model (browser + node). JS copy of grader.py: keep the two in step (python parity_check.py compares them).
   Per-round rate (decayed, shrunk to the team) x Elo strength adjustment x expected rounds -> negative binomial P(over),
   graded on the old letter scale by edge (pp) of the pick side over the book's break-even:
   A+ = Over >= +6pp, B = Over >= +3pp, C = no edge (and every filtered prop, reason shown), D = Under >= +3pp, F = Under >= +6pp. */
(function(root){
'use strict';
// PARAMS: tuned by backtest.py on the early slice. MUST match PARAMS in grader.py.
var PARAMS={"m": 100, "half_life": 8, "n_max": 20, "m_team": 1500, "elo_k": 16, "beta": 0.25, "rd_a": 17.34, "rd_b": 16.18, "h2h_min": 3, "h2h_w": 0.0, "w_line": 1.0, "g_kills": 0.6573, "g_hs": 0.3404, "size_kills": 20.0, "size_hs": 16.0, "min_series": 8, "grade_a": 6.0, "grade_b": 3.0};
var BOOK_BE={"prizepicks":0.577,"underdog":0.53},DEFAULT_BE=0.577,VERSION='v2';
var TEAM_ALIASES={"betm33": "33", "wraithpcific": "pcific", "lowcortisolbr": "lowcortisol", "lifesagame": "lag"};
var SKIP={team:1,esports:1,esport:1,gaming:1,club:1};
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function tn(s){var k=String(s||'').toLowerCase().split(/[^a-z0-9]+/).filter(function(w){return w&&!SKIP[w]}).join('');return Object.prototype.hasOwnProperty.call(TEAM_ALIASES,k)?TEAM_ALIASES[k]:k}
function teq(a,b){a=tn(a);b=tn(b);return !!a&&a===b}
function americanBe(o){var x=parseFloat(o);if(isNaN(x))return null;if(x<=-100)return -x/(-x+100);if(x>=100)return 100/(x+100);return null}
function breakEven(book,odds){var b=americanBe(odds);if(b!=null)return b;var k=norm(book);return Object.prototype.hasOwnProperty.call(BOOK_BE,k)?BOOK_BE[k]:DEFAULT_BE}
function winp(ra,rb){return 1/(1+Math.pow(10,(rb-ra)/400))}
function nbProbs(mu,size,line){ // [P(X>line), P(X==line), P(X<line)]
 if(mu<=0)return[0,line===0?1:0,line>0?1:0];
 var q=size/(size+mu),pk=Math.pow(q,size),fl=Math.floor(line),below=0,eq=0;
 for(var k=0;k<=fl;k++){if(k===line)eq=pk;else if(k<line)below+=pk;pk=pk*(k+size)/(k+1)*(1-q)}
 return[Math.max(0,1-below-eq),eq,below]}
function pOverNP(mu,size,line){var r=nbProbs(mu,size,line);return r[0]/Math.max(1e-12,1-r[1])}
function lineMean(line,size){var lo=0,hi=2*line+10;for(var i=0;i<50;i++){var mid=(lo+hi)/2;if(pOverNP(mid,size,line)<0.5)lo=mid;else hi=mid}return(lo+hi)/2}
function blendMean(mu,line,size,w){return w<=0?mu:w*lineMean(line,size)+(1-w)*mu}
function lowerBound(a,x){var lo=0,hi=a.length;while(lo<hi){var m=(lo+hi)>>1;if(a[m]<x)lo=m+1;else hi=m}return lo}
function combos(p){var by={},order=[];(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&l.mid!=null){var g=by[l.mid];if(!g){g=by[l.mid]={mid:l.mid,date:l.date,opp:l.opp,m:{},kills:0,hs:0,hsOk:true,rd:0,rdOk:true};order.push(l.mid)}
  g.m[l.n]=l.map||'';g.kills+=Number(l.kills)||0;if(l.hs==null)g.hsOk=false;else g.hs+=Number(l.hs)||0;if(l.rd==null||l.rd<13)g.rdOk=false;else g.rd+=Number(l.rd)}});
 var out=[];order.forEach(function(m){var g=by[m];if(g.m[1]!=null&&g.m[2]!=null)out.push({mid:String(g.mid),date:g.date||'',opp:g.opp,kills:g.kills,hs:g.hsOk?g.hs:null,rd:g.rdOk?g.rd:null})});
 out.sort(function(a,b){if(a.date!==b.date)return a.date<b.date?1:-1;return a.mid===b.mid?0:(a.mid<b.mid?1:-1)});return out}
function build(players,params){var P={},k;for(k in PARAMS)P[k]=PARAMS[k];if(params)for(k in params)P[k]=params[k];
 var ctx={P:P,players:players,ser:new Map(),eloHist:{},teamCum:{},teamMids:{}};
 var maps=[],seen={},teamRows={};
 players.forEach(function(p){var t=tn(p.team);(p.logs||[]).forEach(function(l){var rd=l.rd,rw=l.rw,key=String(l.mid)+'|'+String(l.n);
   if(typeof rd==='number'&&typeof rw==='number'&&rd>=13&&rw*2!==rd&&!seen[key]){seen[key]=1;maps.push([l.date||'',Number(l.mid)||0,Number(l.n)||0,t,tn(l.opp),rw*2>rd?1:0])}});
  series(ctx,p).forEach(function(c){(ctx.teamMids[t]=ctx.teamMids[t]||[]).push([c.date,c.mid]);if(c.rd)(teamRows[t]=teamRows[t]||[]).push([c.date,c.kills,c.hs!=null?c.hs:0,c.rd])})});
 Object.keys(ctx.teamMids).forEach(function(t){ctx.teamMids[t].sort(function(a,b){if(a[0]!==b[0])return a[0]<b[0]?1:-1;return a[1]===b[1]?0:(a[1]<b[1]?1:-1)})});
 maps.sort(function(a,b){if(a[0]!==b[0])return a[0]<b[0]?-1:1;if(a[1]!==b[1])return a[1]-b[1];return a[2]-b[2]});
 var R={},K=P.elo_k;
 maps.forEach(function(m){var a=m[3],b=m[4],ra=R.hasOwnProperty(a)?R[a]:1500,rb=R.hasOwnProperty(b)?R[b]:1500,e=winp(ra,rb);R[a]=ra+K*(m[5]-e);R[b]=rb-K*(m[5]-e);
  [[a,R[a]],[b,R[b]]].forEach(function(x){var h=ctx.eloHist[x[0]]=ctx.eloHist[x[0]]||[[],[]];h[0].push(m[0]);h[1].push(x[1])})});
 // the python side appends both teams' entries only after both ratings are updated: same as above
 Object.keys(teamRows).forEach(function(t){var rows=teamRows[t].sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0}),ds=[],ck=[0],ch=[0],cr=[0];
  rows.forEach(function(r){ds.push(r[0]);ck.push(ck[ck.length-1]+r[1]);ch.push(ch[ch.length-1]+r[2]);cr.push(cr[cr.length-1]+r[3])});ctx.teamCum[t]=[ds,ck,ch,cr]});
 return ctx}
function series(ctx,p){var s=ctx.ser.get(p);if(!s){s=combos(p);ctx.ser.set(p,s)}return s}
function elo(ctx,team,before){var h=ctx.eloHist[tn(team)];if(!h)return 1500;var i=lowerBound(h[0],before||'9999');return i>0?h[1][i-1]:1500}
function teamPrior(ctx,team,st,before){var P=ctx.P,g=st==='kills'?P.g_kills:P.g_hs,c=ctx.teamCum[tn(team)];if(!c)return g;var i=lowerBound(c[0],before||'9999');return((st==='kills'?c[1]:c[2])[i]+P.m_team*g)/(c[3][i]+P.m_team)}
function teamLastMids(ctx,team,before,n){var rows=ctx.teamMids[tn(team)]||[],out=[];before=before||'9999';n=n||3;for(var i=0;i<rows.length;i++){if(rows[i][0]<before&&out.indexOf(rows[i][1])<0){out.push(rows[i][1]);if(out.length>=n)break}}return out}
function project(ctx,p,st,opp,team,before){var P=ctx.P;team=team||p.team;before=before||'9999';
 var cs=series(ctx,p).filter(function(c){return c.date<before}),rows=cs.filter(function(c){return c.rd&&c[st]!=null}).slice(0,P.n_max);if(!rows.length)return null;
 var prior=teamPrior(ctx,team,st,before),sk=0,sr=0,sw=0,sp=0;
 rows.forEach(function(c,i){var w=Math.pow(0.5,i/P.half_life);sk+=w*c[st];sr+=w*c.rd;sw+=w;sp+=w*winp(elo(ctx,team,c.date),elo(ctx,c.opp,c.date))});
 var rate=(sk+P.m*prior)/(sr+P.m),h2h=rows.filter(function(c){return opp&&teq(c.opp,opp)});
 if(h2h.length>=P.h2h_min&&P.h2h_w>0){var hk=0,hr=0;h2h.forEach(function(c){hk+=c[st];hr+=c.rd});rate=(1-P.h2h_w)*rate+P.h2h_w*((hk+P.m*rate)/(hr+P.m))}
 var pbar=sp/sw,et=elo(ctx,team,before),pw=opp?winp(et,elo(ctx,opp,before)):pbar,adj=1+P.beta*(pw-pbar),rounds=2*(P.rd_a+P.rd_b*pw*(1-pw));
 return{mu:rate*adj*rounds,rate:rate,prior:prior,adj:adj,pwin:pw,pbar:pbar,rounds:rounds,n:cs.length,nRate:rows.length,h2h:h2h.length,cs:cs}}
function filters(ctx,p,team,n,before){var P=ctx.P,out=[];before=before||'9999';
 if(team&&!teq(p.team,team))out.push('player is not on '+team+' in the data');
 if(n<P.min_series)out.push('only '+n+' earlier Map 1+2 series (need '+P.min_series+')');
 var last=teamLastMids(ctx,p.team,before),mine={};series(ctx,p).forEach(function(c){if(c.date<before)mine[c.mid]=1});
 if(last.length>=3&&last.filter(function(m){return mine[m]}).length<2)out.push('missed 2+ of the team\'s last 3 series (stand-in or roster change)');
 return out}
function finish(ctx,mu,line,st,book,odds,reasons){var P=ctx.P,size=st==='kills'?P.size_kills:P.size_hs,muF=blendMean(mu,line,size,P.w_line),r=nbProbs(muF,size,line),np=Math.max(1e-12,1-r[1]),
 po=r[0]/np,pu=r[2]/np,be=breakEven(book,odds),pick=po>=pu?'OVER':'UNDER',pp=Math.max(po,pu),epp=(pp-be)*100;reasons=(reasons||[]).slice();
 var g=epp>=P.grade_a?(pick==='OVER'?'A+':'F'):epp>=P.grade_b?(pick==='OVER'?'B':'D'):'C';if(reasons.length)g='C';
 return{proj:mu,muBlend:muF,edge:mu-line,grade:g,pick:pick,pOver:po,pPush:r[1],pPick:pp,be:be,edgePP:epp,reasons:reasons,model:VERSION}}
function grade(ctx,p,st,line,opp,o){o=o||{};if(line==null||isNaN(line))return null;var pr=project(ctx,p,st,opp,o.team||p.team,o.before);if(!pr)return null;
 var r=finish(ctx,pr.mu,+line,st,o.book,o.odds,filters(ctx,p,o.team,pr.n,o.before));r.n=pr.n;r.rounds=pr.rounds;r.pwin=pr.pwin;r.rate=pr.rate;r.prior=pr.prior;r.adj=pr.adj;r.cs=pr.cs;r.nRate=pr.nRate;return r}
function gradeCombo(ctx,ps,names,st,line,opp,o){o=o||{};var mu=0,reasons=[],nmin=999,parts=[];
 for(var i=0;i<ps.length;i++){var p=ps[i],pr=project(ctx,p,st,opp,o.team||p.team,o.before);if(!pr)return null;mu+=pr.mu;nmin=Math.min(nmin,pr.n);parts.push({name:p.name,proj:pr.mu,n:pr.n});
  filters(ctx,p,o.team,pr.n,o.before).forEach(function(x){reasons.push(names[i]+': '+x)})}
 var r=finish(ctx,mu,+line,st,o.book,o.odds,reasons);r.n=nmin;r.parts=parts;return r}
var api={PARAMS:PARAMS,VERSION:VERSION,TEAM_ALIASES:TEAM_ALIASES,tn:tn,teq:teq,norm:norm,breakEven:breakEven,americanBe:americanBe,nbProbs:nbProbs,lineMean:lineMean,
 build:build,series:series,elo:elo,project:project,filters:filters,finish:finish,grade:grade,gradeCombo:gradeCombo};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GPModel=api;
})(typeof window!=='undefined'?window:this);
