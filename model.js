/* Grader model (browser + node). JS copy of grader.py: keep the two in step (python parity_check.py compares them).
   Active letters for new grades (v1e): unchanged v1 projection (35% L10, 20% season, 20% H2H from 1 meeting,
   15% same tier, 10% L3, ADR nudge). P(over/under) from a calibrated residual (fit per stat/scope on series
   before 2026-10-20, no look-ahead; integer lines use a continuity correction). Pick is the higher-probability
   side. Edge pts = (P(side) - book break-even) * 100; break-even from American odds, else PrizePicks 57.7% /
   Underdog 53%, else 57.7%. Letter/stake from that edge (A+ 2U >=18 pts ... F below break-even). LAN kills and
   bait-flagged props are capped at C+ (never A/B). Already-locked props keep their stored letter. */
(function(root){
'use strict';
// PARAMS: tuned by backtest.py on the early slice. MUST match PARAMS in grader.py.
var PARAMS={"m": 100, "half_life": 8, "n_max": 200, "m_team": 1500, "elo_k": 16, "beta": 0.25, "rd_a": 17.34, "rd_b": 16.18, "h2h_min": 1, "h2h_w": 0.1, "w_line": 0.7, "g_kills": 0.6573, "g_hs": 0.3404, "size_kills": 20.0, "size_hs": 16.0, "min_series": 8, "grade_a": 4.0, "grade_b": 0.0, "grade_f": 3.0, "w_rank": 0.25, "rank_s": 1.0, "w_maps": 0.25, "k_maps": 6.0, "w_hr": 0.0, "k_hr": 5.0, "w_hr_l5": 0.25, "w_hr_l10": 0.25, "w_hr_l20": 0.25, "w_hr_szn": 0.25, "hr_upgrade_a": 0.0, "hr_upgrade_b": 0.0, "hr_szn_min": 8, "w_l5": 0.1, "w_l10": 0.05, "w_l20": 0.05, "w_szn": 0.05, "w_kd": 0.1, "k_kd": 40.0,
 "w_hs5": 0.3, "w_hs10": 0.2, "w_hs20": 0.15, "w_hsszn": 0.1, "w_khs5": 0.1, "w_khs10": 0.05, "w_khs15": 0.025, "w_khsszn": 0.0, "k_hsp": 30.0, "w_hkd": -0.1, "lan_data": 1, "lan_k": 5.0, "lan_adr_min": 3, "map_data": 1, "map_k": 5.0};
// lan_data / lan_k / lan_adr_min: LAN-match props use the player's LAN series for every v1 input (see grader.py PARAMS comment).
// map_data / map_k: after v1 + ADR, shrink toward the player's per-map average (all games on that map, k=5). Known maps if the veto is in, else scout veto full-pool expected maps. Map 1 = one map; Maps 1-2 = two (or 2 x expected per-map). Logs before the match day only.
// w_hs* / w_khs* / k_hsp: HS% form inputs for the headshots / kills projection. See grader.py.
var HS_WIN=["5","10","20","szn"];  // headshots-projection HS% windows
var KHS_WIN=["5","10","15","szn"];  // kills-projection HS% factor windows (no L20)
// w_l5..w_szn, w_kd, k_kd: kill-model form inputs (kills props only). See grader.py.
// w_hr / k_hr: hit rate vs the current line blended into P(over) (0 = shown, not used). See grader.py.
// w_hr_l5 / w_hr_l10 / w_hr_l20 / w_hr_szn, hr_upgrade_a / hr_upgrade_b / hr_szn_min: letter override (shipped OFF, thresholds 0). See grader.py.
// Cito features (w_rank, rank_s, w_maps, k_maps): only active when team_strength.json is loaded; see grader.py for the meaning.
var BOOK_BE={"prizepicks":0.577,"underdog":0.53},DEFAULT_BE=0.577,VERSION='v1f';
var FIT_CUTOFF='2026-10-20';
var CALIB={kills:{"Maps 1-2":{dist:'norm',bias:0.003,scale:8.248},"Map 1":{dist:'norm',bias:0.032,scale:5.694}},
 hs:{"Maps 1-2":{dist:'norm',bias:0.056,scale:5.158},"Map 1":{dist:'norm',bias:0.041,scale:3.56}}};
var GRADE_SCALE=[[18,'A+',2],[15,'A',1.5],[12,'B+',1],[8,'B',1],[5,'C+',0.5],[2,'C',0.25],[0,'D',0]];
var PLAY_GRADES={ 'A+':1, A:1, 'B+':1, B:1 }, CAP_LETTER='C+', CAP_STAKE=0.5;
var ERF_P=0.3275911,ERF_A=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];
function erfAs(x){var sign=x>=0?1:-1,ax=Math.abs(+x),t=1/(1+ERF_P*ax),a=t*(ERF_A[0]+t*(ERF_A[1]+t*(ERF_A[2]+t*(ERF_A[3]+t*ERF_A[4]))));return sign*(1-a*Math.exp(-ax*ax))}
function normCdf(z){return 0.5*(1+erfAs(z/Math.SQRT2))}
function laplaceCdf(z){return z<0?0.5*Math.exp(z):1-0.5*Math.exp(-z)}
function calibOf(st,period){var per=isMap1Period(period)?'Map 1':'Maps 1-2',block=CALIB[st]||CALIB.kills;return Object.assign({},block[per]||block['Maps 1-2'])}
function residualProbs(proj,line,st,period,nPlayers,calib){
 var c=calib||calibOf(st,period),n=Math.max(nPlayers||1,1),mean=+proj+(+(c.bias||0))*n,scale=+(c.scale||0)*Math.sqrt(n),dist=c.dist||'norm';
 function F(x){if(scale<=1e-12)return x<mean?0:x>mean?1:0.5;var z=(+x-mean)/scale;return dist!=='laplace'?normCdf(z):laplaceCdf(z)}
 line=+line;var pOver,pPush,pUnder;
 if(Math.abs(line-Math.round(line))<1e-9){var lo=line-0.5,hi=line+0.5;pPush=Math.max(0,F(hi)-F(lo));pOver=Math.max(0,1-F(hi));pUnder=Math.max(0,F(lo))}
 else{pPush=0;pOver=Math.max(0,1-F(line));pUnder=Math.max(0,F(line))}
 var tot=pOver+pPush+pUnder;if(tot>0){pOver/=tot;pPush/=tot;pUnder/=tot}
 var np=Math.max(1e-12,1-pPush);return[pOver/np,pPush,pUnder/np]}
function letterFromEdge(epp){var e=+epp;if(isNaN(e))return{grade:'F',stake:0};for(var i=0;i<GRADE_SCALE.length;i++){if(e>=GRADE_SCALE[i][0])return{grade:GRADE_SCALE[i][1],stake:GRADE_SCALE[i][2]}}return{grade:'F',stake:0}}
function isLanMatch(ev,det){if(ev!=null&&ev!=='')return String(ev).toLowerCase()==='lan';return !!(det&&det.lan&&det.lan.used)}
function capReasons(st,ev,bait,det){var out=[];if(bait)out.push('bait');if(st==='kills'&&isLanMatch(ev,det))out.push('lan_kills');return out}
function applyGradeCap(r,st,ev,bait,det){if(!r)return r;if(bait==null)bait=!!r.bait;if(det==null)det=r.v1;var reasons=capReasons(st,ev,bait,det),pre=r.grade,applied=!!reasons.length&&!!PLAY_GRADES[pre];
 if(applied){r.grade=CAP_LETTER;r.stake=CAP_STAKE;r.modelGrade=CAP_LETTER}
 r.gradeCap={applied:applied,reason:reasons.length?reasons.join('+'):null,preGrade:applied?pre:null};return r}
var TEAM_ALIASES={"betm33": "33", "wraithpcific": "pcific", "lowcortisolbr": "lowcortisol", "lifesagame": "lag", "dendelecs": "dendele"};
var SKIP={team:1,esports:1,esport:1,gaming:1,club:1,clan:1};
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
function combos(p){var by={},order=[];(p.logs||[]).forEach(function(l){if((l.n===1||l.n===2)&&l.mid!=null){var g=by[l.mid];if(!g){g=by[l.mid]={mid:l.mid,date:l.date,opp:l.opp,ev:null,m:{},kills:0,hs:0,hsOk:true,rd:0,rdOk:true,d:0,dOk:true,adr:[]};order.push(l.mid)}
  g.m[l.n]=l.map||'';if(l.n===1)g.ev=l.ev==null?null:l.ev;g.kills+=Number(l.kills)||0;if(l.hs==null)g.hsOk=false;else g.hs+=Number(l.hs)||0;if(l.d==null)g.dOk=false;else g.d+=Number(l.d)||0;if(l.rd==null||l.rd<13)g.rdOk=false;else g.rd+=Number(l.rd);if(l.adr!=null)g.adr.push(Number(l.adr))}});
 var out=[];order.forEach(function(m){var g=by[m];if(g.m[1]!=null&&g.m[2]!=null)out.push({mid:String(g.mid),date:g.date||'',opp:g.opp,ev:g.ev,kills:g.kills,hs:g.hsOk?g.hs:null,rd:g.rdOk?g.rd:null,deaths:g.dOk?g.d:null,adr:g.adr.length?g.adr.reduce(function(s,x){return s+x},0)/g.adr.length:null})});
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
 var rows=[];(d.match_maps||[]).forEach(function(r){var maps=(r.maps||[]).map(normMap).filter(Boolean);
  if(maps.length&&r.t1&&r.t2)rows.push({t1:tn(r.t1),t2:tn(r.t2),n1:r.n1,n2:r.n2,start:r.start,maps:maps,src:r.src||'veto',at:r.at})});
 out.match_maps=rows;return out}
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

function normMap(name){var s=String(name||'').trim();if(s.toLowerCase().indexOf('de_')===0)s=s.slice(3);s=s.trim();
 if(!s||['tba','tbd','tbc','unknown','pending','?','-'].indexOf(s.toLowerCase())>=0)return null;
 return s.length>1?s.charAt(0).toUpperCase()+s.slice(1):s.toUpperCase()}
function mapLogRows(p){var logs=p.logs||[],pos={};logs.forEach(function(l){if((l.mid||0)>0)pos[String(l.date)+'|'+l.n+'|'+tn(l.opp)]=1});
 return logs.filter(function(l){return !(l.mid!=null&&l.mid<0&&pos[String(l.date)+'|'+l.n+'|'+tn(l.opp)])})}
// No cutoff (or the '9999' sentinel) means 'as of today'. A non-date cutoff made addDays() return junk, the 60-day map pool came back empty and the per-map (veto) term silently switched off.
function cutDay(before){var d=String(before||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(d)?d:new Date().toISOString().slice(0,10)}
function addDays(d,n){var t=Date.parse(String(d).slice(0,10)+'T00:00:00Z');if(isNaN(t))return d;return new Date(t+n*864e5).toISOString().slice(0,10)}
function poolOf(ctx,D){ctx._pool=ctx._pool||{};if(ctx._pool[D])return ctx._pool[D];var lo=addDays(D,-60),c={},n=0;
 (ctx.gmaps||[]).forEach(function(x){if(x[0]>=lo&&x[0]<D&&x[1]){c[x[1]]=(c[x[1]]||0)+1;n++}});n=n||1;
 return ctx._pool[D]=Object.keys(c).filter(function(m){return c[m]/n>=0.03}).sort()}
function sharesOf(ctx,t,D){var pool=poolOf(ctx,D),lo=addDays(D,-180),c={},n=0,k=1.5;
 ((ctx.teamMaps||{})[t]||[]).forEach(function(g){if(g.date<D&&g.date>=lo&&pool.indexOf(g.map)>=0){c[g.map]=(c[g.map]||0)+1;n++}});
 if(!pool.length)return [{},n];var w={};pool.forEach(function(m){w[m]=((c[m]||0)+k/pool.length)/(n+k)});return [w,n]}
function vetoWeights(ctx,team,opp,D){var pool=poolOf(ctx,D);if(!pool.length)return {};
 var sa=sharesOf(ctx,tn(team),D),sb=opp?sharesOf(ctx,tn(opp),D):[{},0],u=1/pool.length,w,na=sa[1],nb=sb[1];
 if(na&&nb){w={};pool.forEach(function(m){w[m]=(sa[0][m]||u)+(sb[0][m]||u)})}else if(na||nb)w=Object.assign({},na?sa[0]:sb[0]);
 else{w={};pool.forEach(function(m){w[m]=u})}
 var tw=0;Object.keys(w).forEach(function(m){tw+=w[m]});if(tw<=0)return {};var out={};Object.keys(w).forEach(function(m){out[m]=w[m]/tw});return out}
function confirmedMaps(ctx,team,opp,start){var day=String(start||'').slice(0,10);if(!day||!team||!opp)return [];
 var best=[],bestDt=null,d0=Date.parse(day+'T00:00:00Z');if(isNaN(d0))return [];
 (ctx.matchMaps||(ctx.S&&ctx.S.match_maps)||[]).forEach(function(r){
  if(!((teq(r.t1,team)&&teq(r.t2,opp))||(teq(r.t2,team)&&teq(r.t1,opp))))return;
  var d=Date.parse(String(r.start||'').slice(0,10)+'T00:00:00Z');if(isNaN(d))return;var dt=Math.abs(Math.round((d-d0)/864e5));if(dt>1)return;
  var maps=(r.maps||[]).map(normMap).filter(Boolean);if(maps.length&&(bestDt==null||dt<bestDt)){best=maps;bestDt=dt}});
 return best}
function playerMapAvg(ctx,p,st,mapName,before){var want=normMap(mapName);if(!want||!st)return [null,0];var vals=[];
 mapLogRows(p).forEach(function(l){if(String(l.date||'')>=(before||'9999'))return;if(normMap(l.map)!==want)return;if(l[st]==null)return;vals.push(+l[st])});
 return vals.length?[vals.reduce(function(s,x){return s+x},0)/vals.length,vals.length]:[null,0]}
function expectedMapAvg(ctx,p,st,weights,before){var num=0,den=0,nsum=0,used=0,m,a;
 Object.keys(weights||{}).forEach(function(m){var w=weights[m];if(!w||w<=0)return;a=playerMapAvg(ctx,p,st,m,before);if(a[0]==null)return;num+=w*a[0];den+=w;nsum+=a[1];used++});
 if(den<=0||used<=0)return [null,0,0];return [num/den,Math.round(nsum/used),used]}
function mapBlend(ctx,p,st,opp,before,period,maps){var team=p.team,known=(maps||[]).map(normMap).filter(Boolean);
 if(!known.length)known=confirmedMaps(ctx,team,opp,before);var map1=isMap1Period(period);
 if(known.length){
  if(map1){var a=playerMapAvg(ctx,p,st,known[0],before);return {avg:a[0],n:a[1],src:'known',maps:known.slice(0,1),weights:{}}}
  var pieces=[],ns=[],i;for(i=0;i<Math.min(2,known.length);i++){var a=playerMapAvg(ctx,p,st,known[i],before);if(a[0]!=null){pieces.push(a[0]);ns.push(a[1])}}
  if(pieces.length===1){var ev=expectedMapAvg(ctx,p,st,vetoWeights(ctx,team,opp,cutDay(before)),before);if(ev[0]!=null){pieces.push(ev[0]);ns.push(ev[1]||ns[0])}}
  if(pieces.length>=2)return {avg:pieces[0]+pieces[1],n:Math.min(ns[0],ns[1]),src:'known',maps:known.slice(0,2),weights:null};
  if(pieces.length===1)return {avg:pieces[0]*2,n:ns[0],src:'known',maps:known.slice(0,1),weights:null};
  return {avg:null,n:0,src:'known',maps:known,weights:null}}
 var w=vetoWeights(ctx,team,opp,cutDay(before)),per=expectedMapAvg(ctx,p,st,w,before);
 if(per[0]==null)return {avg:null,n:0,src:'veto',maps:[],weights:w};
 return {avg:map1?per[0]:2*per[0],n:per[1],src:'veto',maps:[],weights:w,nMaps:per[2]}}

function build(players,params,strength,ranks){var P={},k;for(k in PARAMS)P[k]=PARAMS[k];if(params)for(k in params)P[k]=params[k];
 var ctx={P:P,players:players,ranks:ranks||{},ser:new Map(),ser1:new Map(),eloHist:{},teamCum:{},teamMids:{},S:prepStrength(strength)};
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
 // Match ScoutData: one row per (mid, n), only maps with rounds >= 13, raw map names.
 var gmaps=[],teamMaps={},allmaps={},teamUniq={};
 players.forEach(function(p){var t=tn(p.team),pos={};(p.logs||[]).forEach(function(l){if((l.mid||0)>0)pos[String(l.date)+'|'+l.n+'|'+tn(l.opp)]=1});
  (p.logs||[]).forEach(function(l){var mid=l.mid;if(mid==null||l.n==null||!l.date)return;
   if(mid<0&&pos[String(l.date)+'|'+l.n+'|'+tn(l.opp)])return;
   var rd=l.rd;if(!(t&&typeof rd==='number'&&rd>=13))return;
   var key=String(mid)+'|'+l.n;
   if(!allmaps[key])allmaps[key]=[l.date,l.map];
   if(!teamUniq[t])teamUniq[t]={};if(!teamUniq[t][key])teamUniq[t][key]={date:l.date,map:l.map}})});
 gmaps=Object.keys(allmaps).map(function(k){return allmaps[k]});
 gmaps.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0});
 Object.keys(teamUniq).forEach(function(t){teamMaps[t]=Object.keys(teamUniq[t]).map(function(k){return teamUniq[t][k]});
  teamMaps[t].sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0})});
 ctx.gmaps=gmaps;ctx.gdates=gmaps.map(function(x){return x[0]});ctx.teamMaps=teamMaps;ctx.matchMaps=(ctx.S&&ctx.S.match_maps)||[];
 return ctx}
function isMap1Period(period){if(typeof GPMap1!=="undefined")return GPMap1.isMap1({period:period});var s=String(period||"Maps 1-2").toLowerCase().replace(/[\s_]/g,"");return s==="map1"||(s.indexOf("map1")===0&&s.indexOf("maps")!==0)}
function map1Combos(p){var by={},order=[];(p.logs||[]).forEach(function(l){if(l.n!==1||l.mid==null)return;if(by[l.mid])return;
  by[l.mid]={mid:l.mid,date:l.date,opp:l.opp,maps:l.map||"Map 1",ev:l.ev==null?null:l.ev,kills:l.kills==null?null:Number(l.kills),hs:l.hs==null?null:Number(l.hs),rd:(l.rd==null||l.rd<13)?null:Number(l.rd),deaths:l.d==null?null:Number(l.d),adr:l.adr==null?null:Number(l.adr)};order.push(l.mid)});
 return order.map(function(k){return by[k]}).sort(function(a,b){return a.date<b.date?1:a.date>b.date?-1:(String(a.mid)<String(b.mid)?1:String(a.mid)>String(b.mid)?-1:0)})}
function series(ctx,p,period){var map1=isMap1Period(period),cache=map1?(ctx.ser1||(ctx.ser1=new Map())):ctx.ser,s=cache.get(p);if(!s){s=map1?map1Combos(p):combos(p);cache.set(p,s)}return s}
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
function hitrates(ctx,p,st,line,opp,before,period){var P=ctx.P;before=before||'9999';var cs=series(ctx,p,period).filter(function(c){return c.date<before&&c[st]!=null});
 var yr=before!=='9999'?String(before).slice(0,4):(cs.length?cs[0].date.slice(0,4):'');function hx(rows){return[rows.filter(function(c){return c[st]>line}).length,rows.length]}
 var out={l5:hx(cs.slice(0,5)),l10:hx(cs.slice(0,10)),l15:hx(cs.slice(0,15)),l20:hx(cs.slice(0,20)),szn:hx(cs.filter(function(c){return c.date.slice(0,4)===yr})),h2h:hx(cs.filter(function(c){return opp&&teq(c.opp,opp)}))};
 var sw=0,sh=0;cs.slice(0,P.n_max).forEach(function(c,i){if(c[st]===line)return;var w=Math.pow(0.5,i/P.half_life);sw+=w;sh+=w*(c[st]>line?1:0)});
 out.p=(sh+P.k_hr*0.5)/(sw+P.k_hr);return out}
function isBait(ctx,p,st,line,before,period){before=before||'9999';var cs=series(ctx,p,period).filter(function(c){return c.date<before&&c[st]!=null}).slice(0,5);
 return cs.length===5&&cs.every(function(c){return c[st]>=line})}
function filters(ctx,p,team,n,before,period){var P=ctx.P,out=[];before=before||'9999';
 if(team&&!teq(p.team,team))out.push('player is not on '+team+' in the data');
 if(n<P.min_series)out.push('only '+n+(isMap1Period(period)?' earlier Map 1 maps':' earlier Map 1+2 series')+' (need '+P.min_series+')');
 var last=teamLastMids(ctx,p.team,before),mine={};series(ctx,p,period).forEach(function(c){if(c.date<before)mine[c.mid]=1});
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
function v1Pieces(ctx,cs,h,st,opp,lan){if(lan){cs=cs.filter(function(c){return c.ev==='lan'});h=h.filter(function(c){return c.ev==='lan'})}
 function nums(rows){return rows.map(function(c){return c[st]}).filter(function(x){return x!=null})}
 var oppRank=opp?rankOf(ctx,opp):null,same=[];
 if(oppRank!=null){var tr=tier(oppRank);cs.forEach(function(c){var r=rankOf(ctx,c.opp);if(r!=null&&tier(r)===tr)same.push(c)})}
 var out={};[['l10',cs.slice(0,10)],['szn',cs],['h2h',h],['tier',same],['l3',cs.slice(0,3)]].forEach(function(x){var v=nums(x[1]);out[x[0]]=[avg(v),v.length]});
 out.adr5=avg(cs.slice(0,5).map(function(c){return c.adr}).filter(function(x){return x!=null}));
 out.adrc=avg(cs.map(function(c){return c.adr}).filter(function(x){return x!=null}));
 out.adrN5=cs.slice(0,5).filter(function(c){return c.adr!=null}).length;out.adrN=cs.filter(function(c){return c.adr!=null}).length;out.n=cs.length;return out}
// ev==='lan' (and P.lan_data): every part from the player's LAN series; thin samples blended with overall (rule in grader.py PARAMS).
function v1ProjectParts(ctx,p,st,opp,before,period,ev,maps){before=before||'9999';var P=ctx.P,cs=series(ctx,p,period).filter(function(c){return c.date<before});
 if(!cs.some(function(c){return c[st]!=null}))return null;var on=norm(opp),h=opp?cs.filter(function(c){return norm(c.opp)===on}):[];
 var A=v1Pieces(ctx,cs,h,st,opp,false),lanOn=ev==='lan'&&!!P.lan_data,L=lanOn?v1Pieces(ctx,cs,h,st,opp,true):null,K=+(P.lan_k||5);
 function blend(key,N){var va=A[key][0],na=A[key][1];if(!lanOn)return[va,na,null];var vl=L[key][0],nl=L[key][1];if(vl==null||va==null)return[va,na,0];
  if(N){var n=Math.min(nl,N);return[(n*vl+(N-n)*va)/N,na,nl]}return[(nl*vl+K*va)/(nl+K),na,nl]}
 var unit=isMap1Period(period)?'Map 1 maps':'series',tag=lanOn?' · LAN data':'';
 var spec=[['l10','Last 10 '+unit,0.35,10],['szn','Season (all '+unit+')',0.20,0],['h2h','Head-to-head'+(opp?' vs '+opp:''),0.20,0],['tier','Same rank tier'+(opp?' as '+opp:''),0.15,0],['l3','Last 3 '+unit,0.10,3]];
 var parts=spec.map(function(s){var b=blend(s[0],s[3]),x={key:s[0],label:s[1]+tag,w:s[2],v:b[0],n:b[1]};if(lanOn)x.nLan=b[2];return x});
 var use=parts.filter(function(x){return x.v!=null}),tw=use.reduce(function(s,x){return s+x.w},0);if(!tw)return null;
 var pre=use.reduce(function(s,x){return s+x.v*x.w},0)/tw,proj=pre,R=A,adrLan=false;
 if(lanOn&&L.adrN5>=(+P.lan_adr_min||3)&&L.adrc){R=L;adrLan=true}
 var adr5=R.adr5,adrc=R.adrc,adrN5=R.adrN5,adrN=R.adrN,adrUsed=adr5!=null&&!!adrc,adrMult=1;
 if(adrUsed){adrMult=Math.max(0.95,Math.min(1.05,1+0.5*(adr5/adrc-1)));proj*=adrMult}
 var mb=P.map_data?mapBlend(ctx,p,st,opp,before,period,maps):null;
 if(mb&&mb.avg!=null&&mb.n){var k=+(P.map_k||5);mb=Object.assign({},mb,{pre:proj,k:k,used:true});proj=(mb.n*mb.avg+k*proj)/(mb.n+k);mb.proj=proj}
 else if(mb){mb=Object.assign({},mb,{used:false,pre:proj,proj:proj})}
 return{proj:proj,pre:pre,parts:parts,adr5:adr5,adrc:adrc,adrMult:adrMult,adrUsed:adrUsed,adrN5:adrN5,adrN:adrN,weightSum:tw,lan:{used:lanOn,n:lanOn?L.n:null,adrLan:adrLan,ev:ev||null},map:mb}}
// ['lan'|'online'|null, source]: games.json ev for this pair within a day of start, else newest logged map of either team in the 3 days before. Same as grader.py match_ev.
function matchEv(ctx,team,opp,start,games,days){days=days||3;var day=String(start||'').slice(0,10)||new Date().toISOString().slice(0,10),d0=Date.parse(day+'T00:00:00Z');if(isNaN(d0))return[null,null];
 var i,g;for(i=0;i<(games||[]).length;i++){g=games[i];if(g.ev!=='lan'&&g.ev!=='online')continue;if(!((teq(g.team1,team)&&teq(g.team2,opp))||(teq(g.team2,team)&&teq(g.team1,opp))))continue;
  var dg=Date.parse(String(g.start).slice(0,10)+'T00:00:00Z');if(!isNaN(dg)&&Math.abs(Math.round((dg-d0)/864e5))<=1)return[g.ev,'games']}
 if(!ctx.teamEv){var te={};ctx.players.forEach(function(p){var t=tn(p.team);(p.logs||[]).forEach(function(l){if((l.ev==='lan'||l.ev==='online')&&l.date){var m=te[t]=te[t]||{};var k=l.date;m[k]=m[k]==='lan'||l.ev==='lan'?'lan':'online'}})});ctx.teamEv=te}
 var lo=new Date(d0-days*864e5).toISOString().slice(0,10),best=null;
 [tn(team),tn(opp)].forEach(function(t){var m=ctx.teamEv[t];if(!m)return;var top=null;Object.keys(m).forEach(function(k){if(k<day&&(top==null||k>top))top=k});if(top!=null&&top>=lo&&(best==null||top>best[0]))best=[top,m[top]]});
 return best?[best[1],'recent maps']:[null,null]}
function v1Project(ctx,p,st,opp,before,period,ev,maps){var d=v1ProjectParts(ctx,p,st,opp,before,period,ev,maps);return d?d.proj:null}
function v1Result(ctx,mu,line,st,book,odds,reasons,period,nPlayers){if(line==null||isNaN(line)||+line===0)return null;var proj=round1(mu),pr=residualProbs(proj,+line,st,period,nPlayers),po=pr[0],pPush=pr[1],pu=pr[2];
 var pick=Math.abs(po-pu)<1e-6?(proj>=+line?'OVER':'UNDER'):(po>pu?'OVER':'UNDER'),pPick=pick==='OVER'?po:pu,be=breakEven(book,odds),epp=(pPick-be)*100,ls=letterFromEdge(epp);
 var size=st==='kills'?ctx.P.size_kills:ctx.P.size_hs,muF=blendMean(proj,+line,size,ctx.P.w_line);
 reasons=(reasons||[]).slice();
 return{proj:proj,muBlend:muF,edge:proj-+line,grade:ls.grade,pick:pick,stake:ls.stake,pOver:po,pPush:pPush,pPick:pPick,be:be,edgePP:epp,reasons:reasons,flag:reasons.join('; '),model:VERSION,hrBlend:null,hrUpgrade:null,modelGrade:ls.grade,modelPick:pick,
  underBe:{applied:false,pu:null,be:null,epp:null,preGrade:null},gradeCap:{applied:false,reason:null,preGrade:null}}}
function grade(ctx,p,st,line,opp,o){o=o||{};if(line==null||isNaN(line))return null;var maps=o.maps||confirmedMaps(ctx,o.team||p.team,opp,o.before||o.start);var det=v1ProjectParts(ctx,p,st,opp,o.before,o.period,o.ev,maps);if(!det)return null;
 var nV1=series(ctx,p,o.period).filter(function(c){return c.date<(o.before||'9999')}).length;
 var r=v1Result(ctx,det.proj,+line,st,o.book,o.odds,filters(ctx,p,o.team,nV1,o.before,o.period),o.period,1);if(!r)return null;
 r.v1=det;r.period=isMap1Period(o.period)?'Map 1':'Maps 1-2';
 var hits=hitrates(ctx,p,st,+line,opp,o.before,o.period);r.hits={l5:hits.l5,l10:hits.l10,l15:hits.l15,l20:hits.l20,szn:hits.szn,h2h:hits.h2h};r.pHr=hits.p;
 var csAll=series(ctx,p,o.period).filter(function(c){return c.date<(o.before||'9999')}),rows=csAll.filter(function(c){return c.rd&&c[st]!=null}).slice(0,ctx.P.n_max);
 r.h2hN=0;r.h2hRate=null;r.n=nV1;r.rounds=null;r.roundsElo=null;r.roundsMaps=null;r.pRank=null;r.pwin=null;r.rate=null;r.prior=null;r.adj=null;r.cs=null;r.nRate=null;
 if(rows.length){var form=formOf(ctx,csAll,rows,o.before),hsf=hsFormOf(ctx,csAll,o.team||p.team,o.before);
  r.kd=form.kd;r.kpm=form.kpm;r.formN=form.n;r.hsp={l5:hsf.raw['5'],l10:hsf.raw['10'],l15:hsf.raw['15'],l20:hsf.raw['20'],szn:hsf.raw.szn};r.hspN={l5:hsf.n['5'],l10:hsf.n['10'],l15:hsf.n['15'],l20:hsf.n['20'],szn:hsf.n.szn}}
 else{r.kd=null;r.kpm={l5:null,l10:null,l15:null,l20:null,szn:null};r.formN={l5:0,l10:0,l15:0,l20:0,szn:0};r.hsp={l5:null,l10:null,l15:null,l20:null,szn:null};r.hspN={l5:0,l10:0,l15:0,l20:0,szn:0}}
 r.bait=isBait(ctx,p,st,+line,o.before,o.period);applyGradeCap(r,st,o.ev,r.bait,det);return r}
function gradeCombo(ctx,ps,names,st,line,opp,o){o=o||{};var mu=0,reasons=[],nmin=999,parts=[];
 for(var i=0;i<ps.length;i++){var p=ps[i],pj=v1Project(ctx,p,st,opp,o.before,o.period,o.ev);if(pj==null)return null;mu+=pj;var nser=series(ctx,p,o.period).filter(function(c){return c.date<(o.before||'9999')}).length;nmin=Math.min(nmin,nser);parts.push({name:p.name,proj:pj,n:nser});
  filters(ctx,p,o.team,nser,o.before,o.period).forEach(function(x){reasons.push(names[i]+': '+x)})}
 var r=v1Result(ctx,mu,+line,st,o.book,o.odds,reasons,o.period,ps.length);if(!r)return null;r.n=nmin;r.parts=parts;r.period=isMap1Period(o.period)?'Map 1':'Maps 1-2';r.bait=false;applyGradeCap(r,st,o.ev,false,null);return r}
var api={PARAMS:PARAMS,VERSION:VERSION,TEAM_ALIASES:TEAM_ALIASES,CALIB:CALIB,GRADE_SCALE:GRADE_SCALE,FIT_CUTOFF:FIT_CUTOFF,PLAY_GRADES:PLAY_GRADES,CAP_LETTER:CAP_LETTER,tn:tn,teq:teq,norm:norm,breakEven:breakEven,americanBe:americanBe,nbProbs:nbProbs,lineMean:lineMean,erfAs:erfAs,normCdf:normCdf,laplaceCdf:laplaceCdf,residualProbs:residualProbs,letterFromEdge:letterFromEdge,calibOf:calibOf,applyGradeCap:applyGradeCap,capReasons:capReasons,
 build:build,decodePlayers:decodePlayers,hitrates:hitrates,isBait:isBait,prepStrength:prepStrength,pRank:pRank,pwin:pwin,mapRounds:mapRounds,series:series,map1Combos:map1Combos,isMap1Period:isMap1Period,elo:elo,project:project,v1Project:v1Project,v1ProjectParts:v1ProjectParts,matchEv:matchEv,normMap:normMap,confirmedMaps:confirmedMaps,mapBlend:mapBlend,vetoWeights:vetoWeights,filters:filters,finish:finish,grade:grade,gradeCombo:gradeCombo};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GPModel=api;
})(typeof window!=='undefined'?window:this);
