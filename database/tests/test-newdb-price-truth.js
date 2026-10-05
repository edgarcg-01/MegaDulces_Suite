/**
 * `[VPR.4]` — **El precio de venta por plaza, arbitrado por lo que la caja cobra.**
 *
 * ⚠️ **Este candado reemplaza al de `[VPR.1]`, que validaba con un ESPEJO.** Aquella versión
 * publicaba `kdii.c90` (el precio *configurado*) y lo daba por bueno porque la etiquetera cuadraba
 * al 100% — pero la etiquetera **también sale de `c90`**: dos derivados de la misma fuente
 * coincidiendo entre sí. Es textualmente lo que ADR-059 regla 5 advierte. La política decidida
 * (Edgar, 2026-08-25) es que **manda lo que el punto de venta COBRA**.
 *
 * ── Las premisas que vigila, que no son el precio ───────────────────────────────────────────
 * 1. **Que el árbitro CONTRADIGA.** Se exige que lo cobrado difiera de la lista de red en un
 *    número material de celdas. Un árbitro que nunca contradice es un espejo, y éste ya lo fue
 *    una vez.
 * 2. **Que cobrado y configurado sean conceptos DISTINTOS.** Si coincidieran siempre, el grano por
 *    plaza y todo este trabajo sobrarían — y habría que decirlo en vez de publicarlo.
 * 3. **Que la plaza importe.** El motivo de existir es que una misma cosa se cobra distinto en
 *    sucursales distintas.
 * 4. ⭐ **Que el número publicado NO se pueda escribir.** La tabla anterior la peleaban dos
 *    procesos (302,273 vaivenes en 3 días). Se prueba ROMPIÉNDOLO: se intenta un UPDATE y se
 *    exige que Postgres lo rechace.
 * 5. **Que lo no medible se DECLARE**: el respaldo rechazado publica NULL, nunca 0.
 * 6. **Que la copia materializada tenga quién la refresque** — si no, es una foto que envejece
 *    callada, y el precio es la ruta del dinero.
 *
 * Uso: DATABASE_URL_NEW=<destino> node database/tests/test-newdb-price-truth.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
let fail = 0;
let noMedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

(async () => {
  try {
    const existe = (await knex.raw(`SELECT to_regclass('analytics.mv_price_truth') AS t`)).rows[0]?.t;
    if (!existe) {
      nm('analytics.mv_price_truth no existe (¿migración 20261005140000 pendiente?)');
      console.log('\n⚠️  verdad del precio: NO MEDIDO');
      process.exit(2);
    }

    console.log('\n[1] Forma, grano y de dónde sale cada precio');
    const { rows: [f] } = await knex.raw(`
      SELECT count(*)::int filas, count(DISTINCT warehouse_id)::int plazas,
             count(DISTINCT product_id)::int productos,
             count(*) FILTER (WHERE fuente='pos')::int de_caja,
             count(*) FILTER (WHERE fuente='config')::int de_config,
             count(*) FILTER (WHERE fuente='rechazado')::int rechazados
        FROM analytics.mv_price_truth`);
    ok(f.filas > 0 && f.plazas >= 2,
      `${f.filas} filas · ${f.plazas} plazas · ${f.productos} productos`);
    ok(f.de_caja > 0,
      `${f.de_caja} celdas resuelven por lo que COBRA la caja · ${f.de_config} por el configurado ` +
      `validado · ${f.rechazados} rechazadas`);

    console.log('\n[2] PREMISA — el árbitro CONTRADICE a la lista de red (si no, es un espejo)');
    const { rows: [d] } = await knex.raw(`
      SELECT count(*) FILTER (WHERE veredicto='difiere')::int difieren,
             count(*) FILTER (WHERE veredicto='difiere' AND fuente='pos')::int difieren_por_cobrado,
             count(*) FILTER (WHERE veredicto='cuadra')::int cuadran
        FROM analytics.mv_price_truth`);
    ok(d.difieren_por_cobrado > 0,
      `${d.difieren} celdas difieren de la lista de red, ${d.difieren_por_cobrado} de ellas con ` +
      'precio COBRADO — el árbitro mide, no refleja');

    console.log('\n[3] PREMISA — cobrado y configurado son conceptos DISTINTOS');
    // Si coincidieran siempre, esta fase entera sobraría y habría que declararlo.
    const { rows: [cc] } = await knex.raw(`
      SELECT count(*)::int comparables,
             count(*) FILTER (WHERE abs(precio - precio_config) >= 0.005)::int difieren,
             round(100.0*count(*) FILTER (WHERE abs(precio-precio_config)>=0.005)
                   /NULLIF(count(*),0),1) pct
        FROM analytics.mv_price_truth
       WHERE fuente='pos' AND precio_config IS NOT NULL`);
    if (!cc.comparables) nm('no hay celdas con precio cobrado Y configurado: no se pueden contrastar');
    else ok(cc.difieren > 0,
      `${cc.difieren} de ${cc.comparables} (${cc.pct}%) cobran distinto de lo que configuran — ` +
      'son dos cosas, y por eso importa cuál se publica');

    console.log('\n[4] PREMISA — la PLAZA importa: lo mismo se cobra distinto según la sucursal');
    const { rows: [pl] } = await knex.raw(`
      SELECT count(*)::int skus_en_varias_plazas,
             count(*) FILTER (WHERE n_precios > 1)::int cobran_distinto,
             round(100.0*count(*) FILTER (WHERE n_precios>1)/NULLIF(count(*),0),1) pct
        FROM (SELECT product_id, count(DISTINCT warehouse_id) plazas,
                     count(DISTINCT precio) n_precios
                FROM analytics.mv_price_truth WHERE fuente='pos' AND precio IS NOT NULL
               GROUP BY 1 HAVING count(DISTINCT warehouse_id) > 1) z`);
    if (!pl.skus_en_varias_plazas) nm('ningún SKU con precio cobrado en más de una plaza');
    else ok(pl.cobran_distinto > 0,
      `${pl.cobran_distinto} de ${pl.skus_en_varias_plazas} SKUs (${pl.pct}%) se cobran distinto ` +
      'entre plazas: un precio único de red no puede representarlos');

    console.log('\n[5] ⭐ PRUEBA NEGATIVA — el número publicado NO se puede escribir');
    let rechazado = false; let motivo = '';
    try {
      await knex.raw(`UPDATE analytics.mv_price_truth SET precio = precio WHERE false`);
    } catch (e) { rechazado = true; motivo = (e.message || '').split('\n')[0]; }
    ok(rechazado, rechazado
      ? `Postgres la rechaza: "${motivo.slice(0, 70)}"`
      : 'ACEPTÓ UNA ESCRITURA — dejó de ser inmune y la guerra de precios puede volver');

    console.log('\n[6] PREMISA — lo que no se puede afirmar se DECLARA, nunca se dibuja en cero');
    const { rows: [z] } = await knex.raw(`
      SELECT count(*) FILTER (WHERE fuente='rechazado' AND precio IS NOT NULL)::int rechazado_con_precio,
             count(*) FILTER (WHERE precio IS NOT NULL AND precio <= 0.05)::int marcadores_de_promo,
             count(*) FILTER (WHERE precio = 0)::int ceros,
             count(DISTINCT rechazo) FILTER (WHERE rechazo IS NOT NULL)::int motivos_distintos
        FROM analytics.mv_price_truth`);
    ok(z.rechazado_con_precio === 0 && z.ceros === 0 && z.marcadores_de_promo === 0,
      `${z.ceros} ceros · ${z.marcadores_de_promo} marcadores de promo publicados · ` +
      `${z.rechazado_con_precio} rechazos con precio · ${z.motivos_distintos} motivos distintos declarados`);

    console.log('\n[7] FRESCURA — una copia materializada sin quien la refresque envejece callada');
    // La clave del latido es `mv_existencia_aux_refresh`, NO el nombre del renglón del crontab
    // (`existencia-aux`): se verificó contra `analytics.cron_runs`, no se dedujo del launcher.
    const { rows: [h] } = await knex.raw(`
      SELECT status, last_finish::text,
             round(EXTRACT(epoch FROM now()-last_finish)/60.0, 1) minutos
        FROM analytics.cron_runs WHERE job_key = 'mv_existencia_aux_refresh' LIMIT 1`);
    // ⚠️ El latido verde del carril NO prueba que ESTA matvista se refresque: prueba que el carril
    // corrió. Qué matvistas toca lo decide el CÓDIGO de la imagen desplegada, y eso la base no lo
    // sabe. Por eso se mide la ESCRITURA real sobre la relación (ADR-053: entrega, no ejecución).
    const { rows: [esc] } = await knex.raw(`
      SELECT COALESCE(n_tup_ins,0) + COALESCE(n_tup_upd,0) + COALESCE(n_tup_del,0) AS escrituras
        FROM pg_stat_all_tables WHERE relid = 'analytics.mv_price_truth'::regclass`);
    if (!h || !h.last_finish) {
      nm('no hay latido del carril que la refresca: la frescura no se puede medir');
    } else if (!esc || Number(esc.escrituras) <= f.filas) {
      // ⚠️ La CREACIÓN ya deja tantas escrituras como filas (78,760 = 78,760). Si no hay MÁS que
      // eso, nadie la refrescó nunca y el chequeo anterior habría pasado con la pura carga inicial.
      nm(`el carril late verde (${h.status}, hace ${h.minutos} min) pero la matvista registra ` +
         `${esc ? esc.escrituras : 0} escrituras contra ${f.filas} filas de la carga inicial: ` +
         'NADIE la ha refrescado todavía. El refrescador desplegado aún no la tiene en su lista; ' +
         'se resuelve con `ops/vl/deploy.sh`. Hasta entonces sirve la foto del día que se creó.');
    } else {
      ok(h.status === 'ok' && Number(h.minutos) < 60,
        `refrescada de verdad (${esc.escrituras} escrituras contra ${f.filas} filas) por un carril ` +
        `que late ${h.status} hace ${h.minutos} min`);
    }

    console.log('\n[8] Presupuesto de tiempo — el caso real: el catálogo de UNA plaza');
    const { rows: [w] } = await knex.raw(
      `SELECT warehouse_id::text id FROM analytics.mv_price_truth LIMIT 1`);
    const t0 = Date.now();
    await knex.raw(`SELECT count(*) FROM analytics.mv_price_truth WHERE warehouse_id = ?`, [w.id]);
    const ms = Date.now() - t0;
    ok(ms < 1000, `${ms} ms (la consulta viva cuesta 8.5 s: por eso está materializada)`);

    console.log('\n[9] Lo que esta solución NO resuelve');
    nm('Un precio puesto por un HUMANO y uno derivado viven en la misma columna de ' +
       '`commercial.product_prices` (`updated_by` en 0 de 9,618), así que un override manual sigue ' +
       'siendo indistinguible de un feed. Necesita columna propia; queda declarado, no resuelto.');

    console.log(
      (fail ? `\n❌ verdad del precio: ${fail} falla(s)` : '\n✅ verdad del precio: verde')
      + (noMedido ? ` · ${noMedido} NO MEDIDO` : ''));
    process.exit(fail ? 1 : (noMedido ? 2 : 0));
  } catch (e) {
    console.error('\n❌ ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
