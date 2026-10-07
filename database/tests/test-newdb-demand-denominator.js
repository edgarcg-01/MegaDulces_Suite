/**
 * `[RA-DYN.U2]` — **La demanda se divide entre los días que el almacén pudo vender, no entre 90.**
 *
 * `analytics.inventory_health.avg_daily_units` dividía `units_90d` entre **90 fijo**, y es el
 * número que alimenta `cadenceTarget()` → el objetivo → el **sugerido de compra**. Para un
 * almacén que abrió dentro de la ventana, los días previos a su apertura entraban al denominador
 * como si fueran demanda cero observada.
 *
 * Medido contra prod el 2026-10-01, con el control de correr **las dos fórmulas sobre los mismos
 * datos** (no una contra la foto nocturna, que mezclaría el reloj con el cambio):
 *
 *     almacén    celdas   cambian   demanda   deja sobrestock   pasa a crítico
 *     08          3,300     2,910     ×6.92           1,179            284
 *     07          2,956     2,520     ×3.75             761            180
 *     01-06, 00  18,414         0     ×1.00               0              0
 *
 * O sea **1,940 celdas marcadas `sobrestock` no lo estaban** y **464 estaban en `crítico` sin
 * avisar**, en las dos sucursales más nuevas de la red. Y seis almacenes se mueven exactamente
 * cero — ese cero es el control que prueba que el arreglo apunta a donde dice.
 *
 * ⛔ Dividir entre 90 no es conservador: **afirma que observamos 90 días**. Observamos 13.
 *
 * ── Qué vigila este candado, y qué NO ───────────────────────────────────────────────────────
 * No mira el código: un smoke por regex sobre el fuente no prueba nada. Mira **el dato que el
 * importer dejó** y lo cruza contra una recomputación independiente desde `analytics.sales_daily`.
 *
 * ⚠️ Y no exige igualdad exacta contra esa recomputación: `inventory_health` es una foto nocturna
 * y la venta se movió desde entonces, así que una igualdad mediría el reloj. Se comparan los **dos
 * candidatos entre sí** sobre el mismo `units_90d` recomputado — la deriva afecta igual a los dos
 * y la comparación relativa aguanta.
 *
 * Uso: DATABASE_URL_NEW=<destino> node database/tests/test-newdb-demand-denominator.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
let noMedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

/** Días de la ventana de 90 en que ESE almacén pudo vender. Mismo criterio que los importers. */
const DIAS = `
  SELECT warehouse_id,
         LEAST(90, GREATEST(1, current_date - min(sale_date) + 1))::numeric AS dias
    FROM analytics.sales_daily
   WHERE tenant_id = ? AND sale_date <= current_date
   GROUP BY warehouse_id`;

(async () => {
  try {
    console.log('\n[1] Quién está dentro de la ventana y quién no');
    const { rows: wh } = await knex.raw(`
      SELECT w.code, d.dias::int dias, (d.dias < 90) AS nuevo
        FROM (${DIAS}) d JOIN commercial.warehouses w ON w.id = d.warehouse_id
       ORDER BY d.dias`, [T]);
    const nuevos = wh.filter((r) => r.nuevo).map((r) => r.code);
    ok(wh.length > 0, `${wh.length} almacenes con historia de venta`);
    if (!nuevos.length) {
      nm('ningún almacén abrió dentro de la ventana: el arreglo no tiene a quién aplicarse hoy');
    } else {
      ok(true, `abiertos dentro de la ventana: ${nuevos.join(', ')} · con 90+ días: ${wh.length - nuevos.length}`);
    }

    console.log('\n[2] Cuál de las dos fórmulas explica el dato publicado');
    const { rows: cand } = await knex.raw(`
      WITH d AS (${DIAS}),
      u AS (
        SELECT sd.product_id, sd.warehouse_id, sum(sd.units) AS units_90d
          FROM analytics.sales_daily sd
         WHERE sd.tenant_id = ? AND sd.sale_date >= current_date - 90
           AND (sd.units > 0 OR sd.revenue > 0) AND sd.channel NOT IN ('mayoreo')
         GROUP BY 1, 2)
      SELECT w.code, d.dias::int dias, count(*)::int celdas,
             count(*) FILTER (WHERE abs(ih.avg_daily_units - u.units_90d / d.dias)
                                  <  abs(ih.avg_daily_units - u.units_90d / 90.0))::int gana_nuevo,
             count(*) FILTER (WHERE abs(ih.avg_daily_units - u.units_90d / 90.0)
                                  <  abs(ih.avg_daily_units - u.units_90d / d.dias))::int gana_viejo
        FROM analytics.inventory_health ih
        JOIN u ON u.product_id = ih.product_id AND u.warehouse_id = ih.warehouse_id
        JOIN d ON d.warehouse_id = ih.warehouse_id
        JOIN commercial.warehouses w ON w.id = ih.warehouse_id
       WHERE ih.tenant_id = ? AND d.dias < 90
       GROUP BY w.code, d.dias ORDER BY w.code`, [T, T, T]);

    if (!cand.length) {
      nm('no hay celdas de almacenes nuevos con venta: nada que cruzar');
    } else {
      for (const r of cand) {
        const total = Math.max(1, r.gana_nuevo + r.gana_viejo);
        const pct = Math.round((r.gana_nuevo / total) * 100);
        if (pct < 50) {
          nm(`${r.code} (${r.dias} d): al dato lo explica todavía el denominador VIEJO en el `
            + `${100 - pct}% de ${r.celdas} celdas. El arreglo está en el código y NO en la tabla: `
            + 'falta que corra el importer.');
        } else {
          ok(pct >= 90,
            `${r.code} (${r.dias} d): el denominador nuevo explica el dato en el ${pct}% de ${r.celdas} celdas`);
        }
      }
    }

    console.log('\n[3] Control estructural: el arreglo NO PUEDE tocar a los almacenes viejos');
    // ⭐ Exacto y sin reloj: para un almacén con 90+ días los dos denominadores son el MISMO
    // número, así que ahí el cambio es un no-op por construcción. Sin este control, un arreglo que
    // dividiera TODO entre un número menor pasaría el bloque [2] igual de verde.
    const { rows: [ctl] } = await knex.raw(`
      SELECT count(*)::int almacenes, count(*) FILTER (WHERE d.dias <> 90)::int tocados
        FROM (${DIAS}) d WHERE d.dias >= 90`, [T]);
    ok(ctl.tocados === 0,
      `${ctl.almacenes} almacenes con 90+ días quedan en denominador 90 exacto (tocados: ${ctl.tocados})`);

    console.log('\n[4] La cobertura en días sale del mismo promedio que se publica');
    // Las dos columnas salen de la MISMA fila: acá no hay deriva de reloj. La tolerancia es
    // relativa porque `days_cover` viene redondeada a un decimal y llega a valores de 4 cifras.
    const { rows: [cov] } = await knex.raw(`
      SELECT count(*)::int celdas,
             count(*) FILTER (
               WHERE abs(ih.days_cover - ih.on_hand / ih.avg_daily_units)
                     <= GREATEST(0.2, abs(ih.days_cover) * 0.01))::int coherentes
        FROM analytics.inventory_health ih
       WHERE ih.tenant_id = ? AND ih.days_cover IS NOT NULL AND ih.avg_daily_units > 0`, [T]);
    if (!cov || cov.celdas === 0) nm('ninguna celda con cobertura publicada');
    else ok(cov.coherentes / cov.celdas >= 0.99,
      `${cov.coherentes} de ${cov.celdas} celdas: cobertura = existencia ÷ demanda publicada`);

    console.log(
      (fail ? `\n❌ denominador de la demanda: ${fail} falla(s)` : '\n✅ denominador de la demanda: verde')
      + (noMedido ? ` · ${noMedido} NO MEDIDO` : ''));
    process.exit(fail ? 1 : (noMedido ? 2 : 0));
  } catch (e) {
    console.error('\n❌ ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
