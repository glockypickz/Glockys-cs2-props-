/* Grader model (browser + node). JS copy of grader.py: keep the two in step (python parity_check.py compares them).
   Active letters for new grades: v1 projection (35% L10, 20% all series, 20% H2H, 15% same rank tier, 10% L3, then a
   small ADR adjustment) and v1 cutoffs on (proj-line)/line: A+ >= +0.15, B >= +0.05, C >= -0.02, D >= -0.10, else F.
   Pick is OVER if proj >= line, else UNDER. When the pick is Under and the letter is D or F, v2 negative-binomial
   P(under) with a 0.7 line blend vs book break-even decides F (>= +3pp) vs D. No hit-rate letter override, no plain A.
   Filter reasons and the bait flag do not change the letter or pick. Already-locked props keep their stored letter. */
(function(root){
'use strict';
// PARAMS: tuned by backtest.py on the early slice. MUST match PARAMS in grader.py.
var PARAMS={"m": 100, "half_life": 8, "n_max": 200, "m_team": 1500, "elo_k": 16, "beta": 0.25, "rd_a": 17.34, "rd_b": 16.18, "h2h_min": 1, "h2h_w": 0.1, "w_line": 0.7, "g_kills": 0.6573, "g_hs": 0.3404, "size_kills": 20.0, "size_hs": 16.0, "min_series": 8, "grade_a": 4.0, "grade_b": 0.0, "grade_f": 3.0, "w_rank": 0.25, "rank_s": 1.0, "w_maps": 0.25, "k_maps": 6.0, "w_hr": 0.0, "k_hr": 5.0, "w_hr_l5": 0.25, "w_hr_l10": 0.25, "w_hr_l20": 0.25, "w_hr_szn": 0.25, "hr_upgrade_a": 0.0, "hr_upgrade_b": 0.0, "hr_szn_min": 8, "w_l5": 0.1, "w_l10": 0.05, "w_l20": 0.05, "w_szn": 0.05, "w_kd": 0.1, "k_kd": 40.0,
 "w_hs5": 0.3, "w_hs10": 0.2, "w_hs20": 0.15, "w_hsszn": 0.1, "w_khs5": 0.1, "w_khs10": 0.05, "w_khs15": 0.025, "w_khsszn": 0.0, "k_hsp": 30.0, "w_hkd": -0.1};
// w_hs* / w_khs* / k_hsp: HS% form inputs for the headshots / kills projection. See grader.py.
var HS_WIN=["5","10","20","szn"];  // headshots-projection HS% windows
var KHS_WIN=["5","10","15","szn"];  // kills-projection HS% factor windows (no L20)
// w_l5..w_szn, w_kd, k_kd: kill-model form inputs (kills props only). See grader.py.
// w_hr / k_hr: hit rate vs the current line blended into P(over) (0 = shown, not used). See grader.py.
// w_hr_l5 / w_hr_l10 / w_hr_l20 / w_hr_szn, hr_upgrade_a / hr_upgrade_b / hr_szn_min: letter override (shipped OFF, thresholds 0). See grader.py.
// Cito features (w_rank, rank_s, w_maps, k_maps): only active when team_strength.json is loaded; see grader.py for the meaning.
var BOOK_BE={"prizepicks":0.577,"underdog":0.53},DEFAULT_BE=0.577,VERSION='v1be';
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
function combos(p){var by={},order=[];(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&l.mid!=null){var g=by[l.mid];if(!g){g=by[l.mid]={mid:l.mid,date:l.date,opp:l.opp,m:{},kills:0,hs:0,hsOk:true,rd:0,rdOk:true,d:0,dOk:true,adr:[]};order.push(l.mid)}
  g.m[l.n]=l.map||'';g.kills+=Number(l.kills)||0;if(l.hs==null)g.hsOk=false;else g.hs+=Number(l.hs)||0;if(l.d==null)g.dOk=false;else g.d+=Number(l.d)||0;if(l.rd==null||l.rd<13)g.rdOk=false;else g.rd+=Number(l.rd);if(l.adr!=null)g.adr.push(Number(l.adr))}});
 var out=[];order.forEach(function(m){var g=by[m];if(g.m[1]!=null&&g.m[2]!=null)out.push({mid:String(g.mid),date:g.date||'',opp:g.opp,kills:g.kills,hs:g.hsOk?g.hs:null,rd:g.rdOk?g.rd:null,deaths:g.dOk?g.d:null,adr:g.adr.length?g.adr.reduce(function(s,x){return s+x},0)/g.adr.length:null})});
 out.sort(function(a,b){if(a.date!==b.date)return a.date<b.date?1:-1;return a.mid===b.mid?0:(a.mid<b.mid?1:-1)});return out}
// team_strength.json (cito_update.py): dated ranking lists and team map stats. Same as prep_strength in grader.py.
// players.json fmt 2 (compact, see encode_players in grader.py) -> plain {players:[{name,team,logs:[{...}]}]}. Plain data is returned as is.
function decodePlayers(d){if(!d||d.fmt!==2)return d;var S=d.s||[],cols=d.cols||[],xc=d.xcols||[],STRC={date:1,map:1,opp:1,ev:1},out={},k;
 for(k in d)if(['fmt','cols','xcols','s','players'].indexOf(k)<0)out[k]=d[k];
 out.players=(d.players||[]).map(function(p){var q={},kk;for(kk in p)if(kk!=='rows')q[kk]=p[kk];
  q.logs=(p.rows||[]).map(function(r){var l={};for(var i=0;i<r.length;i++){var v=r[i];if(v==null)continue;var c=cols[i];
   if(STRC[c])v=S[v];else if(c==='x'){var x={},n=0;for(var j=0;j<xc.length&&j<v.length;j++)if(v[j]!=null){x[xc[j]]=v[j];n++}if(!n)continue;v=x}l[c]=v}return l});return q});
 return out}
function prepStrength(d){var out={rank:{},maps:{}};if(!d||typeof d!=='object')return out;
 ['vrs','world'].forEach(function(kind){var snaps=[];((d.rankings||{})[kind]||[]).forEach(function(sn){var pts={};Object.keys(sn.points||{}).forEach(function(k){var v=sn.points[k],t=tn(k);
   if(typeof v==='number'&&v>0&&t&&!Object.prototype.hasOwnProperty.call(pts,t))pts[t]=v});if(sn.date&&Object.keys(pts).length)snaps.push([String(sn.date).slice(0,10),pts])});
  snaps.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0});out.rank[kind]=[snaps.map(function(x){return x[0]}),snaps.map(function(x){return x[1]})]});
 Object.keys(d.maps||{}).forEach(function(k){var t=tn(k);if(!t)return;var snaps=[];(d.maps[k]||[]).forEach(function(sn){var mp={},n=0;Object.keys(sn.maps||{}).forEach(function(m){var v=sn.maps[m];
   if(Array.isArray(v)&&v.length>=3&&(v[0]||0)>0){mp[String(m)]=[+v[0],+(v[1]||0),+(v[2]||0)];n++}});if(sn.asof&&n)snaps.push([String(sn.asof).slice(0,10),mp])});
  if(snaps.length){var prev=out.maps[t]||[[],[]],all=prev[0].map(function(x,i){return[x,prev[1][i]]}).concat(snaps);all.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0});
   out.maps[t]=[all.map(function(x){return x[0]}),all.map(function(x){return x[1]})]}});
 return out}
function latest(h,before){if(!h||!h[0].length)return null;var i=lowerBound(h[0],String(before||'9999').slice(0,10));return i>0?h[1][i-1]:null}
function pRank(ctx,team,opp,before){var a=tn(team),b=tn(opp),s=ctx.P.rank_s,ps=[];['vrs','world'].forEach(function(kind){var sn=latest(ctx.S.rank[kind],before);
  if(sn&&Object.prototype.hasOwnProperty.call(sn,a)&&Object.prototype.hasOwnProperty.call(sn,b)){var x=Math.pow(sn[a],s),y=Math.pow(sn[b],s);ps.push(x/(x+y))}});
 return ps.length?ps.reduce(function(u,v){return u+v},0)/ps.length:null}
function pwin(ctx,team,opp,before){var p=winp(elo(ctx,team,before),elo(ctx,opp,before)),w=ctx.P.w_rank;if(w>0){var pr=pRank(ctx,team,opp,before);if(pr!=null)p=(1-w)*p+w*pr}return p}
function mapRounds(ctx,team,opp,before,base){var sa=latest(ctx.S.maps[tn(team)],before),sb=opp?latest(ctx.S.maps[tn(opp)],before):null;if(!sa&&!sb)return null;var k=ctx.P.k_maps;
 function rdm(m){var n=0,r=0;[sa,sb].forEach(function(sn){if(sn&&Object.prototype.hasOwnProperty.call(sn,m)){n+=sn[m][0];r+=sn[m][1]}});return(r+k*base)/(n+k)}
 function pickE(sn){var names=Object.keys(sn).sort(),w=names.map(function(m){return sn[m][2]}),tw=w.reduce(function(u,v){return u+v},0);
  if(tw<=0){w=names.map(function(m){return sn[m][0]});tw=w.reduce(function(u,v){return u+v},0)}if(tw<=0)return null;var t=0;names.forEach(function(m,i){t+=w[i]*rdm(m)});return t/tw}
 var es=[sa?pickE(sa):null,sb?pickE(sb):null].filter(function(e){return e!=null});return es.length?es.reduce(function(u,v){return u+v},0)/es.length:null}
function build(players,params,strength,ranks){var P={},k;for(k in PARAMS)P[k]=PARAMS[k];if(params)for(k in params)P[k]=params[k];
 var ctx={P:P,players:players,ranks:ranks||{},ser:new Map(),eloHist:{},teamCum:{},teamMids:{},S:prepStrength(strength)};
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
 rows.forEach(function(c,i){var w=Math.pow(0.5,i/P.half_life);sk+=w*c[st];sr+=w*c.rd;sw+=w;sp+=w*pwin(ctx,team,c.opp,c.date)});
 var rate=(sk+P.m*prior)/(sr+P.m),h2h=rows.filter(function(c){return opp&&teq(c.opp,opp)}),h2hRate=null;
 var hk=0,hr=0;h2h.forEach(function(c){hk+=c[st];hr+=c.rd});if(hr>0)h2hRate=hk/hr;
 if(h2h.length>=P.h2h_min&&P.h2h_w>0){rate=(1-P.h2h_w)*rate+P.h2h_w*((hk+P.m*rate)/(hr+P.m))}
 var form=formOf(ctx,cs,rows,before);if(st==='kills'){['l5','l10','l20','szn'].forEach(function(k){if(P['w_'+k]>0&&form.rate[k]!=null)rate+=P['w_'+k]*(form.rate[k]-rate)});if(P.w_kd>0&&form.kdS!=null)rate*=Math.pow(form.kdS,P.w_kd)}
 var hsf=hsFormOf(ctx,cs,team,before);if(st==='kills'){KHS_WIN.forEach(function(k){var w=P['w_khs'+k];if(w!==0)rate*=Math.pow(hsf.s[k]/(k!=='szn'?hsf.s.szn:hsf.team),w)})}
 else if(HS_WIN.some(function(k){return P['w_hs'+k]!==0})){var krows=cs.filter(function(c){return c.rd&&c.kills!=null}).slice(0,P.n_max),kp=teamPrior(ctx,team,'kills',before),ka=0,kb=0;krows.forEach(function(c,i){var w=Math.pow(0.5,i/P.half_life);ka+=w*c.kills;kb+=w*c.rd});var krate=(ka+P.m*kp)/(kb+P.m);HS_WIN.forEach(function(k){if(P['w_hs'+k]!==0)rate+=P['w_hs'+k]*(krate*hsf.s[k]-rate)})}
 if(st==='hs'&&P.w_hkd!==0&&form.kdS!=null)rate*=Math.pow(form.kdS,P.w_hkd);
 var pbar=sp/sw,pw=opp?pwin(ctx,team,opp,before):pbar,adj=1+P.beta*(pw-pbar),base=P.rd_a+P.rd_b*pw*(1-pw),
  em=P.w_maps>0?mapRounds(ctx,team,opp,before,base):null,rounds=2*(em!=null?base+P.w_maps*(em-base):base);
 return{mu:rate*adj*rounds,rate:rate,prior:prior,adj:adj,pwin:pw,pbar:pbar,rounds:rounds,roundsElo:2*base,roundsMaps:em!=null?2*em:null,pRank:opp?pRank(ctx,team,opp,before):null,
  n:cs.length,nRate:rows.length,h2h:h2h.length,h2hRate:h2hRate,cs:cs,form:form,hsf:hsf}}
// HS% form (same as Grader.hs_form in grader.py)
function hsFormOf(ctx,cs,team,before){var P=ctx.P;before=before||'9999';var yr=before!=='9999'?String(before).slice(0,4):(cs.length?cs[0].date.slice(0,4):''),hc=cs.filter(function(c){return c.hs!=null&&c.kills>0}),tk=teamPrior(ctx,team,'kills',before),th=tk>0?teamPrior(ctx,team,'hs',before)/tk:0.5,
  win={'5':hc.slice(0,5),'10':hc.slice(0,10),'15':hc.slice(0,15),'20':hc.slice(0,20),szn:hc.filter(function(c){return c.date.slice(0,4)===yr})},out={raw:{},s:{},n:{},team:th},sum=function(w,f){var t=0;w.forEach(function(c){t+=c[f]});return t};
 Object.keys(win).forEach(function(k){var H=sum(win[k],'hs'),K=sum(win[k],'kills');out.n[k]=win[k].length;out.raw[k]=K>0?H/K:null});
 out.s.szn=(sum(win.szn,'hs')+P.k_hsp*th)/(sum(win.szn,'kills')+P.k_hsp);['5','10','15','20'].forEach(function(k){out.s[k]=(sum(win[k],'hs')+P.k_hsp*out.s.szn)/(sum(win[k],'kills')+P.k_hsp)});return out}
// kill form (same as Grader.form in grader.py): kpm / per-round rate over last 5 / 10 / 15 / 20 series and the season, season K/D
function formOf(ctx,cs,rows,before){before=before||'9999';var yr=before!=='9999'?String(before).slice(0,4):(cs.length?cs[0].date.slice(0,4):''),win={l5:rows.slice(0,5),l10:rows.slice(0,10),l15:rows.slice(0,15),l20:rows.slice(0,20),szn:rows.filter(function(c){return c.date.slice(0,4)===yr})},out={rate:{},kpm:{},n:{}};
 Object.keys(win).forEach(function(k){var w=win[k],sk=0,sr=0;w.forEach(function(c){sk+=c.kills;sr+=c.rd});out.n[k]=w.length;out.rate[k]=w.length?sk/sr:null;out.kpm[k]=w.length?sk/(2*w.length):null});
 var sz=cs.filter(function(c){return c.date.slice(0,4)===yr&&c.deaths!=null}),K=0,D=0;sz.forEach(function(c){K+=c.kills;D+=c.deaths});out.kd=D>0?K/D:null;out.kdS=sz.length?(K+ctx.P.k_kd)/(D+ctx.P.k_kd):null;return out}
// Hit rates vs this exact line (equal = not over), Maps 1-2 series dated before `before`: l5/l10/l20, szn (calendar year), h2h. Same as grader.py hitrates.
function hitrates(ctx,p,st,line,opp,before){var P=ctx.P;before=before||'9999';var cs=series(ctx,p).filter(function(c){return c.date<before&&c[st]!=null});
 var yr=before!=='9999'?String(before).slice(0,4):(cs.length?cs[0].date.slice(0,4):'');function hx(rows){return[rows.filter(function(c){return c[st]>line}).length,rows.length]}
 var out={l5:hx(cs.slice(0,5)),l10:hx(cs.slice(0,10)),l15:hx(cs.slice(0,15)),l20:hx(cs.slice(0,20)),szn:hx(cs.filter(function(c){return c.date.slice(0,4)===yr})),h2h:hx(cs.filter(function(c){return opp&&teq(c.opp,opp)}))};
 var sw=0,sh=0;cs.slice(0,P.n_max).forEach(function(c,i){if(c[st]===line)return;var w=Math.pow(0.5,i/P.half_life);sw+=w;sh+=w*(c[st]>line?1:0)});
 out.p=(sh+P.k_hr*0.5)/(sw+P.k_hr);return out}
function isBait(ctx,p,st,line,before){before=before||'9999';var cs=series(ctx,p).filter(function(c){return c.date<before&&c[st]!=null}).slice(0,5);
 return cs.length===5&&cs.every(function(c){return c[st]>=line})}
function filters(ctx,p,team,n,before){var P=ctx.P,out=[];before=before||'9999';
 if(team&&!teq(p.team,team))out.push('player is not on '+team+' in the data');
 if(n<P.min_series)out.push('only '+n+' earlier Map 1+2 series (need '+P.min_series+')');
 var last=teamLastMids(ctx,p.team,before),mine={};series(ctx,p).forEach(function(c){if(c.date<before)mine[c.mid]=1});
 if(last.length>=3&&last.filter(function(m){return mine[m]}).length<2)out.push('missed 2+ of the team\'s last 3 series (stand-in or roster change)');
 return out}
function hitrateUpgrade(hits,P){var reasons=[],blend=null,up=null;
 if(!hits||!(((P.hr_upgrade_a||0)>0)||((P.hr_upgrade_b||0)>0)))return{blend:blend,upgrade:up,reasons:reasons};
 var sz=hits.szn||[0,0],szn=sz[1]||0,sznMin=P.hr_szn_min||8;
 if(szn<sznMin){reasons.push('only '+szn+' season series vs this line (need '+sznMin+' for the hit-rate grade)');return{blend:blend,upgrade:up,reasons:reasons}}
 var wins=[['l5',5,'w_hr_l5'],['l10',10,'w_hr_l10'],['l20',20,'w_hr_l20'],['szn',null,'w_hr_szn']],num=0,den=0,thin=[];
 for(var i=0;i<wins.length;i++){var k=wins[i][0],need=wins[i][1],w=P[wins[i][2]]||0;if(w<=0)continue;var v=hits[k]||[0,0],n=v[1]||0;if(n<=0)continue;num+=w*(v[0]/n);den+=w;if(need&&n<need)thin.push(k.toUpperCase()+' '+n)}
 if(den<=0)return{blend:blend,upgrade:up,reasons:reasons};blend=num/den;
 if(thin.length)reasons.push('thin hit-rate windows ('+thin.join(', ')+')');
 if(blend>=P.hr_upgrade_a)up='A+';else if(blend>=P.hr_upgrade_b)up='B';
 return{blend:blend,upgrade:up,reasons:reasons}}
function finish(ctx,mu,line,st,book,odds,reasons,hr,hits){var P=ctx.P,size=st==='kills'?P.size_kills:P.size_hs,muF=blendMean(mu,line,size,P.w_line),r=nbProbs(muF,size,line),np=Math.max(1e-12,1-r[1]),
 po=r[0]/np,pu=r[2]/np;if(hr!=null&&P.w_hr>0){po=(1-P.w_hr)*po+P.w_hr*hr;pu=1-po}var be=breakEven(book,odds),pick=Math.abs(po-pu)<1e-6?(mu>=lineMean(line,size)?'OVER':'UNDER'):(po>pu?'OVER':'UNDER'),pp=Math.max(po,pu),epp=(pp-be)*100;reasons=(reasons||[]).slice();
 var g=pick==='OVER'?(epp>=P.grade_a?'A+':epp>=P.grade_b?'B':'C'):(epp>=(P.grade_f!=null?P.grade_f:P.grade_b)?'F':'D');
 var modelPick=pick,modelGrade=g,hu=hitrateUpgrade(hits,P);reasons=reasons.concat(hu.reasons);
 if(hu.upgrade==='A+'||(hu.upgrade==='B'&&g!=='A+')){if(modelPick==='UNDER')reasons.push('model leans Under; hit-rate grade is Over');pick='OVER';g=hu.upgrade}
 return{proj:mu,muBlend:muF,edge:mu-line,grade:g,pick:pick,pOver:po,pPush:r[1],pPick:pp,be:be,edgePP:epp,reasons:reasons,flag:reasons.join('; '),model:VERSION,
  hrBlend:hu.blend,hrUpgrade:hu.upgrade,modelGrade:modelGrade,modelPick:modelPick}}
function round1(x){return Math.round(x*10+(x>=0?1e-8:-1e-8))/10}
function avg(a){return a.length?a.reduce(function(s,x){return s+x},0)/a.length:null}
function rankOf(ctx,name){var k=norm(name),r=ctx.ranks||{},t;for(t in r){if(norm(t)===k)return r[t]}return null}
function tier(r){return r<=5?'t5':r<=15?'t15':r<=30?'t30':'t31'}
var V1_UNDER_W_LINE=0.7;
function v1Shade(proj,line){if(line==null||isNaN(line)||+line===0)return null;var edge=proj-+line,pct=edge/+line;
 var g=pct>=0.15?'A+':pct>=0.05?'B':pct>=-0.02?'C':pct>=-0.10?'D':'F',pick=edge>=0?'OVER':'UNDER';return{grade:g,pick:pick}}
function underBeLetter(grade,pick,proj,line,st,book,odds,P){if(pick!=='UNDER'||(grade!=='D'&&grade!=='F'))return{grade:grade,pick:pick,epp:null,be:null,pu:null};
 var size=st==='kills'?P.size_kills:P.size_hs,mu=round1(proj),muF=blendMean(mu,+line,size,V1_UNDER_W_LINE),r=nbProbs(muF,size,+line),pu=r[2]/Math.max(1e-12,1-r[1]),be=breakEven(book,odds),epp=(pu-be)*100;
 return{grade:epp>=(P.grade_f!=null?P.grade_f:3)?'F':'D',pick:pick,epp:epp,be:be,pu:pu}}
function v1Project(ctx,p,st,opp,before){before=before||'9999';var cs=series(ctx,p).filter(function(c){return c.date<before});
 function nums(rows){return rows.map(function(c){return c[st]}).filter(function(x){return x!=null})}
 var v=nums(cs);if(!v.length)return null;var oppRank=opp?rankOf(ctx,opp):null,on=norm(opp);
 var comp=[[0.35,avg(nums(cs.slice(0,10)))],[0.20,avg(v)]];
 var h=opp?cs.filter(function(c){return norm(c.opp)===on}):[];comp.push([0.20,avg(nums(h))]);
 var same=[];if(oppRank!=null){var tr=tier(oppRank);cs.forEach(function(c){var r=rankOf(ctx,c.opp);if(r!=null&&tier(r)===tr)same.push(c)})}
 comp.push([0.15,avg(nums(same))]);comp.push([0.10,avg(nums(cs.slice(0,3)))]);
 var use=comp.filter(function(x){return x[1]!=null}),tw=use.reduce(function(s,x){return s+x[0]},0);if(!tw)return null;
 var proj=use.reduce(function(s,x){return s+x[1]*x[0]},0)/tw;
 var adr5=avg(cs.slice(0,5).map(function(c){return c.adr}).filter(function(x){return x!=null}));
 var adrc=avg(cs.map(function(c){return c.adr}).filter(function(x){return x!=null}));
 if(adr5!=null&&adrc)proj*=Math.max(0.95,Math.min(1.05,1+0.5*(adr5/adrc-1)));
 return proj}
function v1Result(ctx,mu,line,st,book,odds,reasons){var sh=v1Shade(mu,line);if(!sh)return null;var proj=round1(mu),ub=underBeLetter(sh.grade,sh.pick,proj,line,st,book,odds,ctx.P);
 var size=st==='kills'?ctx.P.size_kills:ctx.P.size_hs,muF=blendMean(proj,+line,size,ctx.P.w_line),r=nbProbs(muF,size,+line),np=Math.max(1e-12,1-r[1]),po=r[0]/np,pu=r[2]/np,be=breakEven(book,odds),pPick,epp;
 if(ub.epp!=null){epp=ub.epp;pPick=ub.pu;be=ub.be}else{pPick=Math.max(po,pu);epp=(pPick-be)*100}
 reasons=(reasons||[]).slice();
 return{proj:proj,muBlend:muF,edge:proj-+line,grade:ub.grade,pick:ub.pick,pOver:po,pPush:r[1],pPick:pPick,be:be,edgePP:epp,reasons:reasons,flag:reasons.join('; '),model:VERSION,hrBlend:null,hrUpgrade:null,modelGrade:ub.grade,modelPick:ub.pick}}
function grade(ctx,p,st,line,opp,o){o=o||{};if(line==null||isNaN(line))return null;var mu=v1Project(ctx,p,st,opp,o.before);if(mu==null)return null;
 var nV1=series(ctx,p).filter(function(c){return c.date<(o.before||'9999')}).length;
 var r=v1Result(ctx,mu,+line,st,o.book,o.odds,filters(ctx,p,o.team,nV1,o.before));if(!r)return null;
 var hits=hitrates(ctx,p,st,+line,opp,o.before);r.hits={l5:hits.l5,l10:hits.l10,l15:hits.l15,l20:hits.l20,szn:hits.szn,h2h:hits.h2h};r.pHr=hits.p;
 var pr=project(ctx,p,st,opp,o.team||p.team,o.before);
 if(pr){r.h2hN=pr.h2h;r.h2hRate=pr.h2hRate;r.n=pr.n;r.rounds=pr.rounds;r.roundsElo=pr.roundsElo;r.roundsMaps=pr.roundsMaps;r.pRank=pr.pRank;r.kd=pr.form.kd;r.kpm=pr.form.kpm;r.formN=pr.form.n;r.hsp={l5:pr.hsf.raw['5'],l10:pr.hsf.raw['10'],l15:pr.hsf.raw['15'],l20:pr.hsf.raw['20'],szn:pr.hsf.raw.szn};r.hspN={l5:pr.hsf.n['5'],l10:pr.hsf.n['10'],l15:pr.hsf.n['15'],l20:pr.hsf.n['20'],szn:pr.hsf.n.szn};r.pwin=pr.pwin;r.rate=pr.rate;r.prior=pr.prior;r.adj=pr.adj;r.cs=pr.cs;r.nRate=pr.nRate}
 else{r.h2hN=0;r.h2hRate=null;r.n=nV1;r.rounds=null;r.roundsElo=null;r.roundsMaps=null;r.pRank=null;r.kd=null;r.kpm={l5:null,l10:null,l15:null,l20:null,szn:null};r.formN={l5:0,l10:0,l15:0,l20:0,szn:0};r.hsp={l5:null,l10:null,l15:null,l20:null,szn:null};r.hspN={l5:0,l10:0,l15:0,l20:0,szn:0};r.pwin=null;r.rate=null;r.prior=null;r.adj=null;r.cs=null;r.nRate=null}
 r.bait=isBait(ctx,p,st,+line,o.before);return r}
function gradeCombo(ctx,ps,names,st,line,opp,o){o=o||{};var mu=0,reasons=[],nmin=999,parts=[];
 for(var i=0;i<ps.length;i++){var p=ps[i],pj=v1Project(ctx,p,st,opp,o.before);if(pj==null)return null;mu+=pj;var nser=series(ctx,p).filter(function(c){return c.date<(o.before||'9999')}).length;nmin=Math.min(nmin,nser);parts.push({name:p.name,proj:pj,n:nser});
  filters(ctx,p,o.team,nser,o.before).forEach(function(x){reasons.push(names[i]+': '+x)})}
 var r=v1Result(ctx,mu,+line,st,o.book,o.odds,reasons);if(!r)return null;r.n=nmin;r.parts=parts;r.bait=false;return r}
var api={PARAMS:PARAMS,VERSION:VERSION,TEAM_ALIASES:TEAM_ALIASES,tn:tn,teq:teq,norm:norm,breakEven:breakEven,americanBe:americanBe,nbProbs:nbProbs,lineMean:lineMean,
 build:build,decodePlayers:decodePlayers,hitrates:hitrates,isBait:isBait,prepStrength:prepStrength,pRank:pRank,pwin:pwin,mapRounds:mapRounds,series:series,elo:elo,project:project,v1Project:v1Project,filters:filters,finish:finish,grade:grade,gradeCombo:gradeCombo};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GPModel=api;
})(typeof window!=='undefined'?window:this);
