'use strict';
/* eslint-disable no-console */
const path=require('path');
require('dotenv').config({path:path.resolve(__dirname,'..','..','.env'),quiet:true});
const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:process.env.FLEET_DB_URL,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const q=async(t,s)=>{try{const r=await c.query(s);console.log('\n== '+t);console.table(r.rows);}catch(e){console.log('\n== '+t+'  ⚠ '+e.message);}};
  await q('las opciones REALES del filtro de la pantalla',`
    select distinct w.code||'|'||s.route_code valor, s.route_no, w.name
    from analytics.sales_by_route_monthly s
    join commercial.warehouses w on w.id=s.warehouse_id and w.tenant_id=s.tenant_id
    where s.route_code like 'WIN-%' order by 3, 2`);
  await q('¿el puente propuesto arma ese valor exacto?',`
    select rz.route_code, rz.tipo, rz.parent_code,
           rz.parent_code||'|WIN-'||rz.route_code armado,
           exists(select 1 from analytics.sales_by_route_monthly s
                  join commercial.warehouses w on w.id=s.warehouse_id and w.tenant_id=s.tenant_id
                  where s.route_code='WIN-'||rz.route_code and w.code=rz.parent_code) casa
    from (
      select btrim(r.source_branch) route_code,
             case when btrim(r.branch_name) ilike '%VECINAL%' then 'vecinal' else 'ruta' end tipo,
             w.code parent_code, (btrim(r.branch_name) ilike '%hist%') historica
      from wincaja.branches r
      join wincaja.branches p on p.tenant_id=r.tenant_id and btrim(p.source_branch)=btrim(r.parent_branch) and p.is_route=false
      join commercial.warehouses w on w.tenant_id=r.tenant_id and w.deleted_at is null
       and w.code=coalesce(nullif(btrim(p.kepler_code),''),nullif(btrim(p.warehouse_code),''))
      where r.is_route
    ) rz where not rz.historica order by 3, 1`);
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1);});
