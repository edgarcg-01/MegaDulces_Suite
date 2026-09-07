/* eslint-disable no-console */
/**
 * ADR-055 — CANDADO: la cantidad se muestra en la UNIDAD MÁS GRANDE (la caja), y el divisor es el
 * del ERP que manda en ESE almacén.
 *
 * El bug que este test existe para que no vuelva: `/compras/pedido` dividía la existencia de TODOS
 * los almacenes por un único factor por producto (`analytics.v_product_box_factor.box_factor` =
 * unidades BASE de Kepler por caja). Pero los almacenes de Wincaja (MD-30/MD-32/00) guardan la
 * existencia en SU unidad de venta, que en los multipack es el PAQUETE — así que la existencia
 * salía ~10× más chica. Y como `analytics.product_demand.daily_pieces` SÍ normaliza la demanda de
 * Wincaja a la unidad base, el motor comparaba PIEZAS de demanda contra PAQUETES de existencia:
 *   · $866,756 de sobre-pedido (MD-30 $753k + MD-32 $113k)
 *   · $2.68M de inventario que la pantalla no mostraba
 *
 * Los dos intentos anteriores fallaron y por eso hay candados explícitos contra ambos:
 *   1. convertir la existencia CRUDA a piezas (mig 20260902200000) → rompió el pedido, porque
 *      `inventory_health`/`reorder_policy` se derivan de `analytics.sales_daily`, que está en la
 *      unidad nativa de Wincaja. La conversión es de PRESENTACIÓN, nunca del dato base.
 *   2. `LEFT JOIN wincaja.articulos` sin `source_dataset='actual'` → duplicó la existencia (la
 *      tabla guarda 'actual' Y 'concentrada' por sucursal).
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-warehouse-box-factor.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  console.log('\n=== ADR-055 · unidad más grande + tabla de existencias por ERP ===\n');

  // ── 1. El resolvedor es una VISTA (derivar-no-copiar) y expone el contrato ──────────────────
  const rel = (await c.query(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.v_warehouse_box_factor')`)).rows[0];
  check('v_warehouse_box_factor existe', !!rel);
  check('es VISTA, no tabla copiada', rel && rel.relkind === 'v', rel ? `relkind=${rel.relkind}` : 'ausente');

  const cols = (await c.query(`SELECT column_name FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='v_warehouse_box_factor'`)).rows.map((r) => r.column_name);
  for (const col of ['tenant_id', 'warehouse_id', 'product_id', 'sku', 'box_factor',
    'factor_source', 'erp', 'box_label', 'base_label', 'is_weight', 'is_master_suspect']) {
    check(`expone ${col}`, cols.includes(col));
  }

  // ── 2. El divisor nunca es 0 ni negativo (dividir por él es la operación central) ───────────
  const guard = (await c.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE box_factor IS NULL OR box_factor < 1)::int malos,
      count(DISTINCT warehouse_id)::int almacenes
    FROM analytics.v_warehouse_box_factor WHERE tenant_id=$1`, [T])).rows[0];
  check('el resolvedor cubre producto × almacén', guard.n > 10000, `n=${guard.n}`);
  check('cubre los almacenes con ERP', guard.almacenes >= 8, `almacenes=${guard.almacenes}`);
  check('ningún factor NULL ni < 1', guard.malos === 0, `malos=${guard.malos}`);

  // ── 3. Cada ERP resuelve con SU propia tabla ────────────────────────────────────────────────
  const byErp = (await c.query(`SELECT erp,
      count(*) FILTER (WHERE factor_source = 'wincaja_factor_venta')::int wcj,
      count(*)::int n
    FROM analytics.v_warehouse_box_factor WHERE tenant_id=$1 GROUP BY erp`, [T])).rows;
  const kep = byErp.find((r) => r.erp === 'kepler');
  const wcj = byErp.find((r) => r.erp === 'wincaja');
  check('los almacenes Kepler NUNCA usan factor_venta de Wincaja', kep && kep.wcj === 0, kep ? `wcj=${kep.wcj}` : 'sin filas kepler');
  check('los almacenes Wincaja sí resuelven con su propia tabla', wcj && wcj.wcj > 1000, wcj ? `wcj=${wcj.wcj}` : 'sin filas wincaja');

  // ── 4. CANDADO ANTI-DUPLICACIÓN: una fila por (almacén, producto), nunca dos ────────────────
  // Si el join a wincaja.articulos vuelve a olvidar source_dataset='actual', esto explota.
  const dup = (await c.query(`SELECT count(*)::int dups FROM (
      SELECT warehouse_id, product_id FROM analytics.v_warehouse_box_factor WHERE tenant_id=$1
       GROUP BY 1,2 HAVING count(*) > 1) z`, [T])).rows[0];
  check('sin filas duplicadas por (almacén, producto)', dup.dups === 0, `dups=${dup.dups}`);

  // ── 5. El fact lleva el divisor resuelto y coincide con la vista ────────────────────────────
  const planCol = (await c.query(`SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='replenishment_plan' AND column_name='display_bf'`)).rows[0];
  check('replenishment_plan.display_bf existe', planCol.n === 1);

  const sync = (await c.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE rp.display_bf IS NULL)::int nulos,
      count(*) FILTER (WHERE abs(rp.display_bf - v.box_factor) > 0.0001)::int desalineados
    FROM analytics.replenishment_plan rp
    JOIN analytics.v_warehouse_box_factor v
      ON v.tenant_id=rp.tenant_id AND v.warehouse_id=rp.warehouse_id AND v.product_id=rp.product_id
   WHERE rp.tenant_id=$1`, [T])).rows[0];
  check('el fact no tiene display_bf en NULL', sync.nulos === 0, `nulos=${sync.nulos}`);
  check('el fact coincide con el resolvedor', sync.desalineados === 0, `desalineados=${sync.desalineados}/${sync.n}`);

  // ── 6. Kepler NO se mueve: es la prueba de que el cambio está acotado a Wincaja ─────────────
  const kepSame = (await c.query(`SELECT count(*)::int distintos
    FROM analytics.replenishment_plan rp
    JOIN commercial.warehouses w ON w.id=rp.warehouse_id
   WHERE rp.tenant_id=$1 AND w.kepler_code IS NOT NULL
     AND abs(rp.display_bf - GREATEST(COALESCE(rp.bf,1),1)) > 0.0001`, [T])).rows[0];
  check('en los almacenes Kepler display_bf == bf (cero impacto)', kepSame.distintos === 0, `distintos=${kepSame.distintos}`);

  // ── 7. LA PRUEBA DE LA UNIDAD: factor_venta cuenta unidades de venta de Wincaja por caja ────
  // Contrastado contra la escalera del ODS (kdii): o es igual a f3 (Wincaja vende la unidad base)
  // o es igual a f3/f2 (vende el paquete). Las dos formas son coherentes con la definición; que
  // NINGUNA se cumpla en la mayoría sería la señal de que el decode está mal.
  const lad = (await c.query(`
    WITH fv AS (
      SELECT DISTINCT a.articulo AS sku, a.factor_venta::numeric AS fv
        FROM wincaja.articulos a
        JOIN commercial.warehouses w
          ON w.tenant_id=a.tenant_id AND w.wincaja_source_branch=a.source_branch AND w.kepler_code IS NULL
       WHERE a.tenant_id=$1 AND a.source_dataset='actual' AND a.factor_venta > 1
    )
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(fv.fv - l.f3) < 0.01)::int igual_f3,
           count(*) FILTER (WHERE l.f2 > 1 AND abs(fv.fv - l.f3/l.f2) < 0.01)::int igual_f3_f2
      FROM fv JOIN analytics.v_product_unit_ladder l ON l.sku = fv.sku
     WHERE l.f3 > 1`, [T])).rows[0];
  const explicados = lad.igual_f3 + lad.igual_f3_f2;
  check('factor_venta se explica con la escalera del ODS (f3 o f3/f2)',
    lad.n > 0 && explicados / lad.n >= 0.9, `${explicados}/${lad.n} explicados`);
  check('hay multipack de verdad (fv = f3/f2), que es el caso que motivó el fix',
    lad.igual_f3_f2 > 100, `multipack=${lad.igual_f3_f2}`);

  // ── 8. CANDADO ANTI-REGRESIÓN #1: el dato BASE no se convierte ──────────────────────────────
  // La vista de existencia sirve la unidad nativa; convertirla rompió el pedido una vez.
  const raw = (await c.query(`
    SELECT count(*)::int n, count(*) FILTER (WHERE abs(v.qty_stock_units - w.existencia) > 0.01)::int convertidos
      FROM analytics.v_erp_stock_on_hand v
      JOIN commercial.warehouses wh ON wh.id = v.warehouse_id AND wh.kepler_code IS NULL
      JOIN wincaja.v_stock w
        ON w.tenant_id=v.tenant_id AND w.source_branch=wh.wincaja_source_branch AND w.sku=v.sku
     WHERE v.tenant_id=$1 AND v.qty_stock_units > 0`, [T])).rows[0];
  if (raw.n === 0) console.log('  ~ sin existencia Wincaja para contrastar (skip)');
  else check('la existencia de Wincaja sigue CRUDA (no se convierte el dato base)',
    raw.convertidos === 0, `convertidos=${raw.convertidos}/${raw.n}`);

  // ── 9. El efecto en dinero: sólo Wincaja cambia, y en la dirección correcta ─────────────────
  const impacto = (await c.query(`
    SELECT round(sum(rp.stock_pz/GREATEST(rp.bf,1)*rp.caja_cost) FILTER (WHERE w.kepler_code IS NULL)::numeric,0) AS antes,
           round(sum(rp.stock_pz/rp.display_bf*rp.caja_cost)    FILTER (WHERE w.kepler_code IS NULL)::numeric,0) AS despues,
           count(*) FILTER (WHERE w.kepler_code IS NULL AND rp.display_bf <> GREATEST(rp.bf,1))::int filas
      FROM analytics.replenishment_plan rp
      JOIN commercial.warehouses w ON w.id=rp.warehouse_id
     WHERE rp.tenant_id=$1`, [T])).rows[0];
  console.log(`\n  existencia Wincaja valuada: ${money(impacto.antes)} → ${money(impacto.despues)} (${impacto.filas} filas corregidas)`);
  check('el fix hace VISIBLE inventario que estaba subdeclarado',
    Number(impacto.despues) > Number(impacto.antes), `${impacto.antes} → ${impacto.despues}`);
  check('corrige un subconjunto acotado, no todo el catálogo',
    impacto.filas > 50 && impacto.filas < 3000, `filas=${impacto.filas}`);

  // ── 10. Nadie compara ya demanda-en-base contra existencia-en-nativa ───────────────────────
  // Réplica del cálculo de la pantalla: las dos patas del pedido tienen que estar en CAJAS.
  const ped = (await c.query(`
    SELECT count(*) FILTER (WHERE dem_cjs > 0 AND exis_cjs > dem_cjs * 30)::int absurdos, count(*)::int n
      FROM (SELECT rp.daily_pieces * 30 / (GREATEST(rp.suf,1) * GREATEST(rp.bf,1)) AS dem_cjs,
                   rp.stock_pz / rp.display_bf AS exis_cjs
              FROM analytics.replenishment_plan rp
              JOIN commercial.warehouses w ON w.id=rp.warehouse_id AND w.kepler_code IS NULL
             WHERE rp.tenant_id=$1 AND rp.daily_pieces > 0 AND rp.stock_pz > 0) z`, [T])).rows[0];
  // 30 meses de cobertura es el síntoma de la conversión al revés (llegó a 534-900 días).
  check('ningún SKU de Wincaja con cobertura absurda (>30 meses) por unidad mal convertida',
    ped.n === 0 || ped.absurdos / ped.n < 0.02, `absurdos=${ped.absurdos}/${ped.n}`);

  console.log(`\n=== ${ok} OK · ${fail} FAIL ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
