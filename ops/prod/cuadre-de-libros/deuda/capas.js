const fs=require('fs');
const rows=fs.readFileSync(process.argv[2] || 'capas-del-vencido.out','utf8').split('\n').filter(l=>l.startsWith('row|')).map(l=>{const p=l.split('|');return {s:p[1],prov:p[2],nom:p[3],t:p[4],f:p[5],fe:p[6],pend:+p[7],dv:+p[8],ac:p[9]==='t',capa:p[10],hasrfc:p[11]==='t',mvig:p[12]==='t',mcan:p[13]==='t',mcan100:p[14]==='t',mvig100:p[15]==='t'}});
const ab=fs.readFileSync(process.argv[3] || 'saldo-a-favor.out','utf8').split('\n').filter(l=>l.startsWith('ab|')).map(l=>{const p=l.split('|');return {prov:p[1],c4:p[2],s:p[3],af:p[4],fe:p[5],rem:+p[6],cta:p[7]}});
const SN={'00':'CEDIS','01':'Hidalgo','02':'La Piedad Abastos','03':'8 Esquinas','04':'Yurecuaro','05':'Zamora Centro','06':'Canindo','07':'Morelia Madero','08':'Morelia Abastos'};
const fmt=n=>Math.round(n).toLocaleString('en-US');
const tot=rows.reduce((a,r)=>a+r.pend,0);
console.log('TOTAL vencido sin TI', rows.length, fmt(tot));
// controls cfdi
const sup=rows.filter(r=>r.hasrfc && !/^(A|B\.B|TC)/.test(r.prov));
console.log('cfdi universe (rfc, no financiera):',sup.length,' m_vig',sup.filter(r=>r.mvig).length,' m_can',sup.filter(r=>r.mcan).length,' m_can_sin_vig',sup.filter(r=>r.mcan&&!r.mvig).length,' placebo can+100',sup.filter(r=>r.mcan100).length,' placebo vig+100',sup.filter(r=>r.mvig100).length);
// supplier offset layer
const fav={};for(const a of ab){fav[a.prov]=fav[a.prov]||{din:0,dev:0};if(['25','26','60'].includes(a.c4))fav[a.prov].din+=a.rem;else fav[a.prov].dev+=a.rem;}
const bysup={};for(const r of rows){if(r.capa!=='resto')continue;(bysup[r.prov]=bysup[r.prov]||[]).push(r);}
let off={din:0,dev:0,n:0};const offEx=[];
for(const [p,list] of Object.entries(bysup)){const F=fav[p];if(!F)continue;let rest=list.reduce((a,r)=>a+r.pend,0);let budget=F.din+F.dev;const used=Math.min(rest,budget);if(used<=1)continue;
  // assign oldest docs first
  list.sort((a,b)=>a.fe<b.fe?-1:1);let u=used;for(const r of list){if(u<=0)break;const x=Math.min(u,r.pend);r.offset=x;u-=x;}
  const ud=Math.min(used,F.din);off.din+=ud;off.dev+=used-ud;off.n++;offEx.push([p,list[0].nom,fmt(rest),fmt(F.din),fmt(F.dev),fmt(used)]);}
const layers={};const add=(k,n,v)=>{layers[k]=layers[k]||{n:0,v:0};layers[k].n+=n;layers[k].v+=v;};
for(const r of rows){if(r.capa!=='resto'){add(r.capa,1,r.pend);continue;}
  const o=r.offset||0;if(o>0)add('e_pagado_sin_aplicar',1,o);const rem=r.pend-o;if(rem<=0.005)continue;
  add(r.ac?'f_antes_corte':'g_desde_corte',1,rem);r.rem=rem;}
for(const [k,x] of Object.entries(layers).sort())console.log('CAPA',k,x.n,fmt(x.v));
console.log('offset suppliers',off.n,'din',fmt(off.din),'dev',fmt(off.dev));
offEx.sort((a,b)=>+b[5].replace(/,/g,'')-+a[5].replace(/,/g,''));console.log('top offset');offEx.slice(0,10).forEach(x=>console.log('  ',x.join(' | ')));
// detail of layers
for(const k of ['a_mas_1_anio','b_residuo','d_cancelada','c_dup_espejo','c_dup_sat','c_dup_misma_ref','a3_anticipo_solicitado']){const l=rows.filter(r=>r.capa===k).sort((a,b)=>b.pend-a.pend);console.log('--',k,l.length);l.slice(0,6).forEach(r=>console.log('   ',SN[r.s],r.prov,r.nom.slice(0,28),r.t,r.f,r.fe,fmt(r.pend)));}
const fin=rows.filter(r=>r.capa==='a2_financiera');const fg={};for(const r of fin){fg[r.prov]=fg[r.prov]||{n:0,v:0,nom:r.nom};fg[r.prov].n++;fg[r.prov].v+=r.pend;}console.log('-- financiera');Object.entries(fg).sort((a,b)=>b[1].v-a[1].v).slice(0,8).forEach(([p,x])=>console.log('   ',p,x.nom.slice(0,30),x.n,fmt(x.v)));
// antiguedad of f_antes_corte
const bk=r=>r.dv<=30?'0-30':r.dv<=60?'31-60':r.dv<=90?'61-90':r.dv<=180?'91-180':'>180';
const ag={};for(const r of rows.filter(r=>r.rem&&r.ac)){const k=bk(r);ag[k]=ag[k]||{n:0,v:0};ag[k].n++;ag[k].v+=r.rem;}console.log('-- antes corte por dias vencido',JSON.stringify(Object.fromEntries(Object.entries(ag).map(([k,x])=>[k,x.n+' / '+fmt(x.v)]))));
// por mes fecha antes corte
const mm={};for(const r of rows.filter(r=>r.rem&&r.ac)){const k=r.fe.slice(0,7);mm[k]=(mm[k]||0)+r.rem;}console.log('-- antes corte por mes factura',JSON.stringify(Object.fromEntries(Object.entries(mm).sort().map(([k,v])=>[k,fmt(v)]))));
// real by sucursal
for(const which of ['g_desde_corte','f_antes_corte']){const flag=which==='f_antes_corte';const bs={};for(const r of rows.filter(r=>r.rem&&r.ac===flag)){bs[SN[r.s]]=(bs[SN[r.s]]||0)+r.rem;}console.log('--',which,'por sucursal',JSON.stringify(Object.fromEntries(Object.entries(bs).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,fmt(v)]))));}
const tp={};for(const r of rows.filter(r=>r.rem)){tp[r.prov]=tp[r.prov]||{nom:r.nom,pre:0,post:0,n:0};tp[r.prov][r.ac?'pre':'post']+=r.rem;tp[r.prov].n++;}
console.log('-- top20 acreedores (antes|desde corte)');Object.entries(tp).sort((a,b)=>(b[1].pre+b[1].post)-(a[1].pre+a[1].post)).slice(0,20).forEach(([p,x])=>console.log('   ',p,x.nom.slice(0,30),x.n,fmt(x.pre),fmt(x.post)));
// gastos vs compras in real
const gt={};for(const r of rows.filter(r=>r.rem)){const k=r.prov[0]+'-'+(r.ac?'pre':'post');gt[k]=(gt[k]||0)+r.rem;}console.log('-- por prefijo',JSON.stringify(Object.fromEntries(Object.entries(gt).map(([k,v])=>[k,fmt(v)]))));
