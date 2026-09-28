/* eslint-disable no-console */
/**
 * RS.9 — Feed del rollup `analytics.sales_by_vendor_monthly` (venta WINCAJA por
 * vendedor). Deriva de `wincaja.v_sales_lines` (view cara) UNA sola vez por mes y
 * persiste el agregado producto × almacén × canal × vendedor × mes, para que el
 * sell-out (mode=canal / by-vendor / vendors) lea ~ms en vez de escanear la view.
 *
 * Replica EXACTO el blend y mapeo del service (commercial-analytics.service.ts):
 *   · blend: wincaja_only OR (PH '10' < 2026-07-01) OR (La Piedad '42' < 2025-10-01)
 *   · warehouse: 10→01, 42→02, resto = warehouse_code
 *   · units: CJA×factor_venta, KGS→kg (unit_kind), resto qty
 *   · vendor_code = source_branch:vendedor · nombre por (sucursal,vendedor)
 * → los totales del rollup coinciden con la query en vivo (solo más rápido).
 *
 * POR LOTES MENSUALES: DELETE+INSERT por mes en su propia transacción → transacciones
 * chicas, sin el pico de WAL/memoria que tumbó la DB managed con un DELETE+INSERT gigante.
 *
 *   node database/importers/wincaja/import-sales-by-vendor-monthly.js          # dry-run (lista meses)
 *   node database/importers/wincaja/import-sales-by-vendor-monthly.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

// ⛔ [AUD-DAT.5] EL CORTE SALE DEL RESOLVEDOR, NO DE LITERALES — y costó una ciudad entera.
//
// Cuando una sucursal migra Wincaja→Kepler, `v_sales_lines.wincaja_only` pasa a **false para TODA
// su historia**, no sólo para lo posterior al corte (medido: branch 30 y 32 tienen `wincaja_only`
// en false en el 100% de sus filas, incluidas las de junio, julio y agosto — meses ANTERIORES a
// su corte del 18-sep y 8-sep). Por eso cada migración necesita una cláusula positiva que devuelva
// su historia al blend. Se escribieron tres a mano —PH '10', La Piedad '42', Canindo '50'— y
// **Morelia nunca recibió la suya**.
//
// Medido en prod 2026-09-28, sólo agosto: el blend viejo traía 35,780 líneas y el derivado trae
// 242,791. Las 207,011 de diferencia son EXACTAMENTE las de Morelia (30: 158,368 · 32: 48,643).
// Cuatro meses sueltos suman 699,114 líneas de venta por vendedor que este rollup no veía, y
// `thot-tools.service.ts` lo lee en vivo para responder "venta real por VENDEDOR".
//
// La causa de fondo no es el olvido: es que la fecha de corte estaba COPIADA. Vive como dato en
// `analytics.v_branch_erp_cutover` (tenant × sucursal Wincaja × fecha), que ya es el resolvedor
// canónico justamente porque esto mismo ya pasó antes y las copias divergieron. Derivarlo hace que
// la próxima migración entre sola.
//
// ⚠️ `cutover_date = -infinity` (sucursales que nunca estuvieron en Wincaja) hace la comparación
// falsa siempre, así que esas sólo entran por `wincaja_only`, igual que antes. Y las rutas
// (501-505) no están en el resolvedor: entran por `wincaja_only = true`, verificado.
//
// ⚠️ COSTO MEDIDO: el filtro pasa de 407 ms a 2,590 ms por mes (6.4×), porque ahora hay 6.8× más
// filas que agregar. Va junto con el cambio de orden (DESC) de abajo a propósito: con el mismo
// presupuesto de 10 min se refresca menos historia, pero la que se refresca es la que se consulta.
// ⚠️ SE LEE UNA VEZ Y SE GENERA EL PREDICADO, no se correlaciona por fila. La forma obvia
// —`vl.business_date < (SELECT cutover_date FROM ... WHERE source_branch = vl.source_branch)`—
// se escribió, se midió y se DESCARTÓ: la consulta de meses dejó de terminar (statement timeout)
// porque correlaciona una subconsulta contra cada línea de una vista de millones. El resolvedor
// tiene 8 filas: se traen al arranque y se hornean como literales, que es lo que el planificador
// sabe optimizar. Sigue sin haber fechas escritas a mano en este archivo — el dato manda.
async function blendDesdeElResolvedor(db, tenant) {
  const { rows } = await db.query(
    `SELECT wincaja_source_branch AS b, cutover_date::text AS d
       FROM analytics.v_branch_erp_cutover
      WHERE tenant_id = $1 AND cutover_date > '-infinity'::date
      ORDER BY 1`, [tenant]);
  if (!rows.length) {
    // Sin resolvedor NO se sigue con `wincaja_only` a secas: eso publicaría el rollup sin la
    // historia de TODAS las sucursales migradas y se vería igual de sano. Mejor romper.
    throw new Error('analytics.v_branch_erp_cutover no devolvió ninguna sucursal con corte — abortado para no publicar un rollup mutilado');
  }
  const clausulas = rows.map((r) => `(vl.source_branch = '${r.b}' AND vl.business_date < DATE '${r.d}')`);
  console.log(`  corte por sucursal (v_branch_erp_cutover): ${rows.map((r) => `${r.b}<${r.d}`).join(' · ')}`);
  const SEP = `
   OR `;
  return `(vl.wincaja_only = true${SEP}${clausulas.join(SEP)})`;
}
// El mapeo de almacén NO se deriva del resolvedor y tampoco le hace falta: las líneas de Morelia
// ya traen `warehouse_code` = '08' / '07' (medido: branch 30 → 08 en 251,801 líneas, branch 32 → 07
// en 59,346), así que caen por el `ELSE` al código correcto. Los tres casos explícitos existen
// porque esas tres SÍ traen el código Wincaja (`MD-10`, `MD-42`, `MD-50`) y hay que traducirlo.
// Se deja como está a propósito: tocar esta expresión mueve a qué almacén se atribuye la venta.
const WH_MAP = `CASE WHEN vl.source_branch='10' THEN '01' WHEN vl.source_branch='42' THEN '02' WHEN vl.source_branch='50' THEN '06' ELSE vl.warehouse_code END`;

// INSERT del mes [d0, d1). Se ejecuta con $1=tenant, $2=d0, $3=d1.
const insertMonthSql = (BLEND) => `
  WITH am AS (
    SELECT DISTINCT ON (articulo) articulo AS sku,
           upper(btrim(coalesce(unidad_venta,''))) AS uv, factor_venta
      FROM wincaja.articulos WHERE tenant_id=$1 ORDER BY articulo, source_dataset DESC),
  ven AS (
    SELECT DISTINCT ON (source_branch, vendedor) source_branch, vendedor, nombre
      FROM wincaja.vendedores WHERE tenant_id=$1 ORDER BY source_branch, vendedor, source_dataset DESC)
  INSERT INTO analytics.sales_by_vendor_monthly
    (id, tenant_id, product_id, warehouse_id, sale_channel, vendor_code, vendor_name,
     year_month, unit_kind, units, revenue, tickets, updated_at)
  SELECT gen_random_uuid(), $1, p.id, w.id, vl.sale_channel,
         (vl.source_branch || ':' || COALESCE(NULLIF(btrim(vl.vendedor),''), '·')),
         coalesce(ven.nombre, NULLIF(btrim(vl.vendedor),''), 'Sin vendedor'),
         to_char(vl.business_date, 'YYYY-MM'),
         CASE WHEN bool_or(am.uv='KGS') THEN 'weight' ELSE 'piece' END,
         SUM(CASE WHEN am.uv='CJA' THEN vl.qty * COALESCE(NULLIF(am.factor_venta,0),1) ELSE vl.qty END),
         SUM(vl.importe),
         count(DISTINCT vl.consecutivo),
         now()
    FROM wincaja.v_sales_lines vl
    JOIN catalog.products p ON p.tenant_id = vl.tenant_id AND p.sku = vl.sku AND p.deleted_at IS NULL AND p.is_promo = false
    JOIN commercial.warehouses w ON w.tenant_id = vl.tenant_id AND w.deleted_at IS NULL AND w.code = ${WH_MAP}
    LEFT JOIN am  ON am.sku = vl.sku
    LEFT JOIN ven ON ven.source_branch = vl.source_branch AND ven.vendedor = vl.vendedor
   WHERE vl.tenant_id = $1 AND ${BLEND}
     AND vl.business_date >= $2 AND vl.business_date < $3
   GROUP BY p.id, w.id, vl.sale_channel, vl.source_branch, vl.vendedor,
            coalesce(ven.nombre, NULLIF(btrim(vl.vendedor),''), 'Sin vendedor'), to_char(vl.business_date, 'YYYY-MM')
  ON CONFLICT (tenant_id, product_id, warehouse_id, sale_channel, vendor_code, year_month) DO UPDATE SET
    vendor_name=EXCLUDED.vendor_name, unit_kind=EXCLUDED.unit_kind, units=EXCLUDED.units,
    revenue=EXCLUDED.revenue, tickets=EXCLUDED.tickets, updated_at=now()
  WHERE (analytics.sales_by_vendor_monthly.vendor_name, analytics.sales_by_vendor_monthly.unit_kind,
         analytics.sales_by_vendor_monthly.units, analytics.sales_by_vendor_monthly.revenue, analytics.sales_by_vendor_monthly.tickets)
        IS DISTINCT FROM
        (EXCLUDED.vendor_name, EXCLUDED.unit_kind, EXCLUDED.units, EXCLUDED.revenue, EXCLUDED.tickets)`;

// DELETE-huérfanos por mes: la fuente `v_sales_lines` puede ENCOGER (reproceso de la réplica
// Wincaja, Fase WR) y el UPSERT solo actualiza/inserta combos vigentes — nunca borra los que
// desaparecieron → quedaban filas fantasma que sobre-declaraban el rollup (+30%). Borra toda fila
// del mes cuya CLAVE (product×almacén×canal×vendedor) ya no produce la fuente viva. Reproduce EXACTO
// el mapeo del INSERT (mismo WH_MAP, BLEND y vendor_code) → cero falsos borrados. Espejo del
// DELETE-huérfanos de import-sales-boxes-monthly (por eso el rollup Kepler sí cuadra al peso).
const deleteOrphanSql = (BLEND) => `
  DELETE FROM analytics.sales_by_vendor_monthly t
   WHERE t.tenant_id = $1 AND t.year_month = $2
     AND NOT EXISTS (
       SELECT 1
         FROM wincaja.v_sales_lines vl
         JOIN catalog.products p ON p.tenant_id = vl.tenant_id AND p.sku = vl.sku AND p.deleted_at IS NULL AND p.is_promo = false
         JOIN commercial.warehouses w ON w.tenant_id = vl.tenant_id AND w.deleted_at IS NULL AND w.code = ${WH_MAP}
        WHERE vl.tenant_id = $1 AND vl.business_date >= $3 AND vl.business_date < $4 AND ${BLEND}
          AND p.id = t.product_id
          AND w.id = t.warehouse_id
          AND vl.sale_channel = t.sale_channel
          AND (vl.source_branch || ':' || COALESCE(NULLIF(btrim(vl.vendedor),''), '·')) = t.vendor_code)`;

const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

(async () => {
  const remote = !/@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST);
  const db = new Client({ connectionString: DST, ssl: remote ? { rejectUnauthorized: false } : false, keepAlive: true, statement_timeout: 0 });
  await db.connect();
  try {
    console.log(`\n=== Rollup venta por vendedor (Wincaja) → analytics.sales_by_vendor_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    // El predicado del blend se HORNEA una vez, desde `analytics.v_branch_erp_cutover`.
    const BLEND = await blendDesdeElResolvedor(db, M);
    const INSERT_MONTH = insertMonthSql(BLEND);
    const DELETE_ORPHAN = deleteOrphanSql(BLEND);
    // ⛔ [AUD-DAT.4] DEL MÁS NUEVO AL MÁS VIEJO. Iba ascendente, y con un presupuesto de 10 min
    // (`timeoutMinFor` en run-prod-feeds) eso significa refrescar la historia y morirse antes de
    // llegar al presente. Medido en prod 2026-09-28, 7 noches seguidas con `TIMEOUT 10 min`: el
    // último mes que alcanzó a tocar fue **2025-11** (43.7 s, `+0 / -0`). El efecto está en la
    // tabla, y es exactamente al revés de lo que uno querría — 2025-10 y 2025-11 refrescados el
    // **27-sep**, mientras 2026-08 seguía congelado desde el **10-sep**: diecisiete días de rezago
    // en el mes que se consulta, para mantener al día dos meses que ya no cambian.
    // `thot-tools.service.ts` lee esta tabla en vivo para "venta real por VENDEDOR".
    //
    // Cada mes cuesta ~44 s y casi siempre escribe CERO (el UPSERT sin churn hace su trabajo):
    // con 20+ meses la pasada completa no entra en 10 min y nunca va a entrar, porque crece uno
    // por mes. Invertir el orden no agranda el presupuesto — decide QUÉ entra en él, y lo que la
    // gente consulta es el mes en curso, no noviembre de 2025.
    //
    // ⚠️ DECLARADO, no resuelto: los meses más viejos van a quedar rezagados. Es tolerable porque
    // Wincaja ya cortó a Kepler en TODAS las sucursales (la última, Morelia Abastos, el
    // 2026-09-18), así que esa historia está congelada y re-derivarla cada noche era trabajo
    // muerto. Acotar la ventana es cambio de ALCANCE y va en un commit aparte, no acá.
    //
    // ⚠️ El `sweep` y el `ANALYZE` del final siguen sin correr cuando hay timeout — y eso explica
    // que el planificador creyera que esta tabla tiene 2 filas cuando tiene 393,238.
    // ⚠️ LA LISTA DE MESES SALE DE LAS CABECERAS, NO DE LAS LÍNEAS. Preguntarle a
    // `v_sales_lines` en qué meses hay venta obliga a materializar el join maestro⋈detalles —
    // 10,027,138 líneas para contestar algo que viven 1,505,074 cabeceras. Medido en prod:
    // 15.8 s como `postgres` y **más de 120 s como `app_runtime`**, que es el rol con el que
    // corre este importer y trae `statement_timeout=120s` puesto en el ROL. Desde las cabeceras:
    // **1.67 s**. La consulta de meses se moría antes de listar un solo mes.
    //
    // Devuelve un SUPERCONJUNTO (33 meses contra los 29 del blend) y eso es seguro a propósito:
    // un mes que el blend no produce se procesa igual, el INSERT escribe cero y el
    // DELETE-huérfanos limpia lo que haya quedado — que es exactamente la corrección de drift
    // que ese DELETE existe para hacer. Al revés no sería seguro: un mes de MENOS deja filas
    // viejas sin nadie que las revise.
    const months = (await db.query(
      `SELECT DISTINCT to_char(wincaja.fecha_dia(m.fecha),'YYYY-MM') ym
         FROM wincaja.maestro_mov_almacen m
        WHERE m.tenant_id=$1 ORDER BY 1 DESC`, [M])).rows.map((r) => r.ym);
    console.log(`  meses a procesar: ${months.length}${months.length ? ` (${months[0]} … ${months[months.length - 1]})` : ''}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    let totalRows = 0, totalDel = 0;
    for (const ym of months) {
      const d0 = `${ym}-01`, d1 = nextMonth(ym), t = Date.now();
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.tenant_id = '${M}'`);
      // UPSERT solo-cambios (no reescribe filas iguales → sin bloat) + DELETE-huérfanos (borra los
      // combos que la fuente viva ya no produce). Ambos en la MISMA trx → atómico, el lector ve el
      // mes viejo o el nuevo, nunca a medias. Corrige el drift cuando `v_sales_lines` encoge.
      const ins = await db.query(INSERT_MONTH, [M, d0, d1]);
      const del = await db.query(DELETE_ORPHAN, [M, ym, d0, d1]);
      await db.query('COMMIT');
      totalRows += ins.rowCount; totalDel += del.rowCount;
      console.log(`  ${ym}: +${ins.rowCount} / -${del.rowCount} huérfanos (${Date.now() - t}ms)`);
    }
    // Barrido de meses que DESAPARECIERON por completo de la fuente (no vuelven en `months` → el
    // DELETE por-mesde arriba nunca los toca). Solo puede borrar meses sin ninguna venta viva.
    if (months.length) {
      const sweep = await db.query(
        `DELETE FROM analytics.sales_by_vendor_monthly WHERE tenant_id = $1 AND year_month <> ALL($2::text[])`, [M, months]);
      if (sweep.rowCount) console.log(`  barrido de meses ausentes: -${sweep.rowCount}`);
      totalDel += sweep.rowCount;
    }
    await db.query(`ANALYZE analytics.sales_by_vendor_monthly`);
    console.log(`\n[APPLY] OK — +${totalRows} / -${totalDel} filas en ${months.length} meses.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
