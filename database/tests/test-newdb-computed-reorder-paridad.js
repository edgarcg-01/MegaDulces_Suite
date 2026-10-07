/**
 * `[RA-DYN.P4.2]` — **La vista dice lo mismo que el importer, o no se cambia nada.**
 *
 * `analytics.v_computed_reorder` deriva en SQL puro lo que `import-computed-reorder.js` escribe en
 * `commercial.reorder_policy` (filas `source='computed'`). Son **dos implementaciones
 * independientes del mismo cálculo**, y eso es exactamente lo que las hace verificables:
 * comprobar una vista contra sí misma pasa bugs en verde — ya pasó en esta suite (IC.0 estaba
 * commiteada con smoke 10/0, cuadrando contra el ODS, y escondía dos bugs que sólo aparecieron al
 * cruzarla con otra implementación).
 *
 * ⛔ **Este test es la compuerta del switch.** Mientras no esté verde, `reorder_policy` la siguen
 * escribiendo los importers y la vista no la consume nadie.
 *
 * ── Lo que puede contaminar la comparación, y por qué se mide antes ─────────────────────────
 * La vista se calcula **al leerse**; la tabla es una foto de las 03:02. Las dos leen
 * `analytics.inventory_health`. Si ese insumo se reescribió después de las 03:02, las diferencias
 * son del reloj, no del cálculo, y exigir igualdad exacta sería un rojo mentiroso. Por eso el
 * bloque [1] compara los relojes y, si el insumo se movió, el bloque [3] **DECLARA `NO MEDIDO`**
 * en vez de inventar un veredicto (ADR-056).
 *
 * ⚠️ `v_abc_class` también es viva, y es un insumo de los dos lados: el importer la lee en su
 * corrida y la vista al leerse. Es la misma definición, no una segunda implementación — pero si
 * la venta de los últimos 365 d movió la clase de un SKU entre las 03:02 y ahora, ese renglón
 * difiere legítimamente. Se declara igual que lo anterior.
 *
 * Uso: DATABASE_URL_NEW=<dev> node database/tests/test-newdb-computed-reorder-paridad.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
let noMedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

/** Las columnas que el switch tiene que preservar al centavo. */
const CAMPOS = ['min_stock', 'reorder_point', 'max_stock', 'safety_stock',
  'service_level', 'lead_time_days', 'abc_class', 'xyz_class'];

(async () => {
  try {
    const vista = (await knex.raw(`SELECT to_regclass('analytics.v_computed_reorder') AS t`)).rows[0]?.t;
    if (!vista) {
      nm('la vista no existe (¿migración 20261001190000 pendiente?)');
      console.log(`\n⚠️  paridad: NO MEDIDO`);
      process.exit(2);
    }

    console.log('\n[1] La función: Acklam en SQL contra valores conocidos');
    for (const [p, z] of [[0.975, 1.959964], [0.98, 2.053749], [0.95, 1.644854], [0.90, 1.281552]]) {
      const got = Number((await knex.raw(`SELECT analytics.fn_inv_norm(?) AS z`, [p])).rows[0].z);
      ok(Math.abs(got - z) < 1e-5, `fn_inv_norm(${p}) = ${got.toFixed(6)} ≈ ${z}`);
    }
    // PRUEBA NEGATIVA: el dominio es (0,1) y fuera de él LANZA, no devuelve 0 — que es lo que
    // hacía el JS y lo que apagaba el colchón en silencio.
    let lanzo = false;
    try { await knex.raw(`SELECT analytics.fn_inv_norm(1.0)`); } catch { lanzo = true; }
    ok(lanzo, 'fn_inv_norm(1.0) LANZA en vez de devolver 0 (el JS devolvía 0 → colchón CERO)');

    console.log('\n[2] Relojes de los insumos (¿la comparación es limpia?)');
    const r = (await knex.raw(`
      SELECT (SELECT max(computed_at) FROM analytics.inventory_health WHERE tenant_id = ?) AS ih,
             (SELECT max(computed_at) FROM commercial.reorder_policy
               WHERE tenant_id = ? AND source = 'computed') AS rp`, [T, T])).rows[0];
    const ih = r.ih ? new Date(r.ih) : null;
    const rp = r.rp ? new Date(r.rp) : null;
    console.log(`     inventory_health: ${r.ih}`);
    console.log(`     reorder_policy  : ${r.rp}`);
    const limpio = ih && rp && ih <= rp;
    ok(!!rp, 'hay filas computed en reorder_policy con que comparar');
    if (!limpio) {
      console.log('     ⚠️  el insumo se movió DESPUÉS de la foto: las diferencias serían del reloj');
    }

    console.log('\n[3] Paridad fila por fila contra la salida del importer');
    const cmp = CAMPOS.map((c) => `v.${c} IS DISTINCT FROM p.${c}`).join(' OR ');
    const q = (await knex.raw(`
      WITH v AS (SELECT * FROM analytics.v_computed_reorder WHERE tenant_id = ?),
           p AS (SELECT * FROM commercial.reorder_policy WHERE tenant_id = ? AND source = 'computed')
      SELECT (SELECT count(*) FROM v)::int                                   AS n_vista,
             (SELECT count(*) FROM p)::int                                   AS n_tabla,
             (SELECT count(*) FROM v JOIN p USING (tenant_id, warehouse_id, product_id))::int AS comunes,
             (SELECT count(*) FROM v JOIN p USING (tenant_id, warehouse_id, product_id)
               WHERE ${cmp})::int                                            AS difieren,
             (SELECT count(*) FROM v LEFT JOIN p USING (tenant_id, warehouse_id, product_id)
               WHERE p.product_id IS NULL)::int                              AS solo_vista,
             (SELECT count(*) FROM p LEFT JOIN v USING (tenant_id, warehouse_id, product_id)
               WHERE v.product_id IS NULL)::int                              AS solo_tabla`, [T, T])).rows[0];
    console.log(`     vista ${q.n_vista} · tabla ${q.n_tabla} · comunes ${q.comunes} · difieren ${q.difieren}`);
    console.log(`     sólo en la vista ${q.solo_vista} · sólo en la tabla ${q.solo_tabla}`);

    /*
     * ⛔ EL ESTÁNDAR NO ES «CERO DIFERENCIAS», ES «CERO DIFERENCIAS SIN EXPLICAR».
     *
     * La primera versión de este bloque exigía que la vista igualara TODA la tabla, y se puso roja
     * midiendo algo que por diseño nunca puede ser cierto: `commercial.reorder_policy` con
     * `source='computed'` la escriben DOS importers, y esta vista reproduce sólo la parte de
     * `import-computed-reorder`. Un rojo que no se puede arreglar se aprende a ignorar, que es
     * peor que no tenerlo.
     *
     * Las tres brechas tienen causa conocida y medida (prod, 2026-10-01) — y lo que se afirma es
     * que NINGUNA fila cae fuera de esas causas:
     *   · difieren 19/15,055 → la clase ABC se movió, porque `v_abc_class` es una vista VIVA que
     *     el importer leyó a las 03:02 y la vista lee ahora. Si un renglón difiere en un campo de
     *     cálculo SIN que la clase haya cambiado, eso sí es un bug y tiene que fallar.
     *   · solo_vista 1,081 → 1,061 son `source='kepler'` (el `ON CONFLICT … WHERE source='computed'`
     *     del importer se niega a pisarlas: los umbrales del ERP ganan) + 20 sin fila.
     *   · solo_tabla 18,472 → 13,626 cedidas al DRP + 4,846 sin demanda hoy (zombis que el importer
     *     nunca borra porque sólo hace UPSERT). Suma exacta.
     */
    const sinExplicar = (await knex.raw(`
      WITH v AS (SELECT * FROM analytics.v_computed_reorder WHERE tenant_id = ?),
           p AS (SELECT * FROM commercial.reorder_policy WHERE tenant_id = ? AND source = 'computed')
      SELECT
        -- difiere en un campo de CÁLCULO sin que la clase ABC se haya movido → bug real
        (SELECT count(*) FROM v JOIN p USING (tenant_id, warehouse_id, product_id)
          WHERE (${cmp}) AND v.abc_class IS NOT DISTINCT FROM p.abc_class)::int AS calc_sin_causa,
        -- está sólo en la vista y NO es por precedencia de kepler ni fila nueva
        (SELECT count(*) FROM v LEFT JOIN commercial.reorder_policy k
                ON k.tenant_id = v.tenant_id AND k.warehouse_id = v.warehouse_id
               AND k.product_id = v.product_id
          WHERE NOT EXISTS (SELECT 1 FROM p WHERE p.warehouse_id = v.warehouse_id AND p.product_id = v.product_id)
            AND k.source IS DISTINCT FROM 'kepler' AND k.id IS NOT NULL)::int AS vista_sin_causa,
        -- está sólo en la tabla y NO es por cesión al DRP ni por falta de demanda
        (SELECT count(*) FROM p
          WHERE NOT EXISTS (SELECT 1 FROM v WHERE v.warehouse_id = p.warehouse_id AND v.product_id = p.product_id)
            AND NOT EXISTS (SELECT 1 FROM commercial.warehouses n
                   JOIN analytics.inventory_health ihc ON ihc.tenant_id = p.tenant_id AND ihc.warehouse_id = n.id
                    AND ihc.product_id = p.product_id AND ihc.avg_daily_units > 0
                  WHERE n.tenant_id = p.tenant_id AND n.source_warehouse_id = p.warehouse_id AND n.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM analytics.inventory_health ih
                  WHERE ih.tenant_id = p.tenant_id AND ih.warehouse_id = p.warehouse_id
                    AND ih.product_id = p.product_id AND ih.avg_daily_units > 0))::int AS tabla_sin_causa
      `, [T, T])).rows[0];

    ok(Number(sinExplicar.calc_sin_causa) === 0,
      `ninguna fila difiere en un campo de cálculo sin que la clase ABC se haya movido (${sinExplicar.calc_sin_causa})`);
    ok(Number(sinExplicar.vista_sin_causa) === 0,
      `ninguna fila sólo-en-la-vista queda sin explicar por precedencia kepler o fila nueva (${sinExplicar.vista_sin_causa})`);
    ok(Number(sinExplicar.tabla_sin_causa) === 0,
      `ninguna fila sólo-en-la-tabla queda sin explicar por cesión al DRP o falta de demanda (${sinExplicar.tabla_sin_causa})`);
    if (!limpio) nm(`el insumo se recalculó después de la foto (ih ${r.ih} > rp ${r.rp}): la deriva de arriba mezcla reloj y cálculo`);
    console.log(`     DECLARADO · deriva de clase viva: ${q.difieren} · precedencia kepler + nuevas: ${q.solo_vista} · DRP + zombis: ${q.solo_tabla}`);

    /*
     * [4] CONTROL — la comparación tiene que DISCRIMINAR.
     * Si el cruce diera "todo igual" por construcción (p. ej. porque el JOIN no empareja nada y
     * `difieren` sale 0 sobre un conjunto vacío), el bloque [3] se pondría verde sin significar
     * nada. Se contrasta contra las filas `source='kepler'`, que son OTRA población con OTROS
     * umbrales: ahí la vista TIENE que diferir.
     */
    console.log('\n[4] CONTROL — el cruce discrimina (no da "igual" por construcción)');
    ok(q.comunes > 0, `el JOIN empareja filas de verdad (${q.comunes}), el veredicto no es sobre el vacío`);
    const kep = (await knex.raw(`
      WITH v AS (SELECT * FROM analytics.v_computed_reorder WHERE tenant_id = ?),
           k AS (SELECT * FROM commercial.reorder_policy WHERE tenant_id = ? AND source = 'kepler')
      SELECT (SELECT count(*) FROM v JOIN k USING (tenant_id, warehouse_id, product_id))::int AS comunes,
             (SELECT count(*) FROM v JOIN k USING (tenant_id, warehouse_id, product_id)
               WHERE ${cmp.replace(/p\./g, 'k.')})::int AS difieren`, [T, T])).rows[0];
    if (kep.comunes === 0) nm('no hay filas kepler que se solapen con la vista — control sin universo');
    else ok(kep.difieren > 0,
      `contra source='kepler' SÍ difiere (${kep.difieren} de ${kep.comunes}): la comparación distingue poblaciones`);

    console.log('\n[5] params_version viaja en cada fila (una política se explica con sus parámetros)');
    const pv = (await knex.raw(
      `SELECT count(*) FILTER (WHERE params_version IS NULL)::int nulos, count(*)::int total
         FROM analytics.v_computed_reorder WHERE tenant_id = ?`, [T])).rows[0];
    ok(pv.total > 0 && pv.nulos === 0, `${pv.total} filas, ${pv.nulos} sin params_version`);

    const estado = fail === 0 ? (noMedido ? '⚠️  VERDE con declarados' : '✅ VERDE') : '❌ ROJO';
    console.log(`\n${estado} — ${fail} falla(s), ${noMedido} no medido(s)`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('  ❌ error inesperado:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
