const knex=require('knex');const M='00000000-0000-0000-0000-00000000d01c';
const db=knex({client:'pg',connection:{connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}},pool:{min:1,max:2}});
(async()=>{
 await db.raw(`SET app.tenant_id='${M}'`).catch(()=>{});
 // 1) gold por año
 const g=await db.raw(`SELECT date_part('year',sale_date)::int y, ROUND(SUM(revenue)::numeric,0) rev, count(*) n FROM analytics.sales_daily WHERE tenant_id=? AND channel LIKE 'wincaja%' GROUP BY 1 ORDER BY 1`,[M]);
 console.log('GOLD wincaja por año:'); for(const r of g.rows) console.log(`  ${r.y}  $${Number(r.rev).toLocaleString()}  (${r.n} filas)`);
 // 2) silver v_sales_daily por dataset+año+ruta
 const s=await db.raw(`SELECT source_dataset ds, date_part('year',business_date)::int y, (source_branch ~ '^(21|22|23|26|27|28|321|322|501|502|503|504|505)$') is_route, count(*) n, ROUND(SUM(importe)::numeric,0) rev FROM wincaja.v_sales_daily GROUP BY 1,2,3 ORDER BY 1,2,3`);
 console.log('\nSILVER v_sales_daily por dataset+año:');
 for(const r of s.rows) console.log(`  ${(r.ds||'?').padEnd(12)} ${r.y} ${r.is_route?'ruta ':'sucur'} ${String(r.n).padStart(8)} $${Number(r.rev).toLocaleString()}`);
 // 3) bronze maestro 2025 por branch (confirmar que cargó)
 const b=await db.raw(`SELECT source_branch, count(*) n, MIN(fecha)::date d0, MAX(fecha)::date d1 FROM wincaja.maestro_mov_almacen WHERE source_dataset='2025' AND tipo='V' GROUP BY 1 ORDER BY 1`);
 console.log('\nBRONZE maestro dataset=2025 (ventas):');
 for(const r of b.rows) console.log(`  br=${String(r.source_branch).padStart(3)} ${String(r.n).padStart(7)} ${r.d0}→${r.d1}`);
 await db.destroy();
})().catch(e=>{console.error(e.message);process.exit(1)});
