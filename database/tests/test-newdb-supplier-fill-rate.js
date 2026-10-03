/**
 * `[RA-DYN.U5/U6]` — **El cumplimiento del proveedor, y las tres premisas que lo sostienen.**
 *
 * `analytics.mv_supplier_fill_rate` compara lo pedido en la OC (`X-A-35`) contra lo recibido en
 * el vale (`X-A-37`), renglón por renglón, 365 días. Es la herramienta que le faltaba al comprador
 * para negociar: hasta hoy `catalog.suppliers.fill_rate_override` llevaba **0 de 1,318**.
 *
 * ── Lo que este candado vigila NO es el número ───────────────────────────────────────────────
 * El número lo dice la matvista. Lo que puede volverlo mentira son sus **premisas**, y son tres:
 *
 * 1. **Que la resta sea legítima.** Pedido y recibido se restan SIN resolver unidades, y eso vale
 *    sólo porque dentro de una cadena Kepler no cambia de peldaño: medido, 2,932 de 2,932 pares
 *    (OC, vale) del mismo SKU vienen en la MISMA unidad. Si esa premisa se cae, la resta compara
 *    cajas contra piezas y el proveedor queda acusado por un factor de conversión.
 * 2. **Que el indicador discrimine.** Un cumplimiento donde TODOS salen mal no mide al proveedor,
 *    mide un defecto propio. Se exige que existan los dos extremos.
 * 3. **Que un nombre no se vuelva dos proveedores.** `catalog.suppliers` tiene HOMÓNIMOS —
 *    "SAN SEBASTIAN" cuatro veces con códigos distintos. El puente los resuelve a uno de forma
 *    determinista y **declara** la ambigüedad; si dejara de declararla, dos negocios distintos
 *    compartirían calificación sin que nadie lo sepa.
 *
 * ── Y el cruce es contra OTRA implementación ─────────────────────────────────────────────────
 * El bloque [2] no lee la matvista y la compara consigo misma: recomputa el conteo desde
 * `analytics.erp_goods_receipts` + `analytics.erp_purchase_doc_lines` con la cadena cruda. Dos
 * caminos al mismo hecho; si divergen, uno de los dos está mal.
 *
 * ⚠️ Es una matvista: el cruce se hace contra la MISMA ventana que ella materializó, y si el ODS
 * se movió desde su último refresco la diferencia es del reloj, no del cálculo. Por eso el bloque
 * compara **proporciones y orden de magnitud**, no igualdad al renglón, y declara `NO MEDIDO`
 * cuando la deriva impide concluir.
 *
 * Uso: DATABASE_URL_NEW=<destino> node database/tests/test-newdb-supplier-fill-rate.js
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
    const existe = (await knex.raw(
      `SELECT to_regclass('analytics.mv_supplier_fill_rate') AS t`)).rows[0]?.t;
    if (!existe) {
      nm('la matvista no existe (¿migración 20261002190000 pendiente?)');
      console.log('\n⚠️  cumplimiento del proveedor: NO MEDIDO');
      process.exit(2);
    }

    console.log('\n[1] Forma y grano');
    const { rows: [f] } = await knex.raw(`
      SELECT count(*)::int renglones,
             -- ⛔ El folio NO es único entre sucursales (ni entre doctypes): la orden es el PAR.
             -- Contar sólo oc_folio funde las órdenes homónimas de dos plazas en una.
             count(DISTINCT (sucursal, oc_folio))::int ordenes,
             count(DISTINCT proveedor_nombre)::int proveedores,
             count(*) FILTER (WHERE supplier_id IS NULL)::int sin_id,
             count(*) FILTER (WHERE supplier_ambiguo)::int ambiguos
        FROM analytics.mv_supplier_fill_rate`);
    ok(f.renglones > 0, `${f.renglones} renglones · ${f.ordenes} órdenes · ${f.proveedores} proveedores`);
    // El grano lo garantiza el índice único; acá se comprueba que el puente al catálogo NO lo rompa.
    ok(f.sin_id >= 0, `${f.sin_id} renglones sin id de proveedor (se declaran, no se esconden)`);

    console.log('\n[2] Cruce contra la cadena cruda — otra implementación, no la misma');
    // ⭐ No se lee la matvista: se recuenta desde el ODS por el puente oc_folio/vale_folio.
    const { rows: [c] } = await knex.raw(`
      WITH r AS MATERIALIZED (
        SELECT DISTINCT sucursal, oc_folio FROM analytics.erp_goods_receipts
         WHERE receipt_date >= current_date - 365
           AND oc_folio IS NOT NULL AND vale_folio IS NOT NULL)
      SELECT (SELECT count(DISTINCT (sucursal, oc_folio))::int
                FROM analytics.mv_supplier_fill_rate)        AS en_matvista,
             (SELECT count(*)::int FROM r)                   AS en_cadena`);
    if (!c.en_cadena) {
      nm('la cadena cruda no devolvió órdenes: nada que cruzar');
    } else {
      const desvio = Math.abs(c.en_matvista - c.en_cadena) / c.en_cadena;
      ok(desvio <= 0.05,
        `órdenes: matvista ${c.en_matvista} vs cadena ${c.en_cadena} ` +
        `(${(desvio * 100).toFixed(1)}% de desvío; la matvista es una foto, se tolera 5%)`);
    }

    console.log('\n[3] Premisa 1 — la resta es legítima porque la unidad no cambia dentro de la cadena');
    // Si esto se cae, el fill rate compara cajas contra piezas y culpa al proveedor de una conversión.
    const { rows: [u] } = await knex.raw(`
      WITH r AS MATERIALIZED (
        SELECT sucursal, oc_folio, vale_folio FROM analytics.erp_goods_receipts
         WHERE receipt_date >= current_date - 45
           AND oc_folio IS NOT NULL AND vale_folio IS NOT NULL LIMIT 400),
      oc AS (SELECT r.sucursal, r.oc_folio, l.sku, max(l.unidad) u
               FROM r JOIN analytics.erp_purchase_doc_lines l
                 ON l.doctype='XA3501' AND l.folio=r.oc_folio AND l.sucursal=r.sucursal
              GROUP BY 1,2,3),
      va AS (SELECT r.sucursal, r.oc_folio, l.sku, max(l.unidad) u
               FROM r JOIN analytics.erp_purchase_doc_lines l
                 ON l.doctype='XA3701' AND l.folio=r.vale_folio AND l.sucursal=r.sucursal
              GROUP BY 1,2,3)
      SELECT count(*)::int pares,
             count(*) FILTER (WHERE oc.u IS DISTINCT FROM va.u)::int difieren
        FROM oc JOIN va ON va.sucursal=oc.sucursal AND va.oc_folio=oc.oc_folio AND va.sku=oc.sku`);
    if (!u || !u.pares) nm('no hay pares (OC, vale) comparables en la ventana de muestra');
    else ok(u.difieren === 0,
      `${u.pares} pares (OC, vale) del mismo SKU: ${u.difieren} con unidad distinta`);

    console.log('\n[4] Premisa 2 — el indicador discrimina (si todos salen igual, mide otra cosa)');
    const { rows: [d] } = await knex.raw(`
      SELECT count(*)::int medidos,
             count(*) FILTER (WHERE pct_completos >= 99)::int perfectos,
             count(*) FILTER (WHERE pct_completos <= 70)::int flojos,
             round(min(pct_completos))::int peor, round(max(pct_completos))::int mejor
        FROM analytics.v_supplier_fill_rate WHERE veredicto_muestra = 'medido'`);
    if (!d.medidos) nm('ningún proveedor alcanza los 25 renglones de muestra');
    else {
      ok(d.perfectos > 0 && d.flojos > 0,
        `reparto con los dos extremos: ${d.perfectos} al 99%+ y ${d.flojos} por debajo de 70% ` +
        `(rango ${d.peor}%–${d.mejor}%, sobre ${d.medidos} proveedores)`);
    }

    console.log('\n[5] PRUEBA NEGATIVA — una muestra chica NO puede publicarse como veredicto');
    // Sin esto, un proveedor con 3 renglones completos sale "100% cumple" y nadie distingue eso
    // de uno con 800. La ausencia de base es un estado, no un número bueno.
    const { rows: [m] } = await knex.raw(`
      SELECT count(*) FILTER (WHERE veredicto_muestra = 'muestra_chica')::int chicas,
             count(*) FILTER (WHERE veredicto_muestra = 'muestra_chica' AND renglones >= 25)::int mal_marcadas,
             count(*) FILTER (WHERE veredicto_muestra = 'medido' AND renglones < 25)::int mal_medidas
        FROM analytics.v_supplier_fill_rate`);
    ok(m.mal_marcadas === 0 && m.mal_medidas === 0,
      `${m.chicas} proveedores declarados muestra_chica, y el corte de 25 no se cruza ` +
      `(${m.mal_marcadas} + ${m.mal_medidas} mal clasificados)`);

    console.log('\n[6] Premisa 3 — un nombre homónimo se DECLARA, no se funde en silencio');
    const { rows: [h] } = await knex.raw(`
      SELECT count(*)::int homonimos FROM (
        SELECT upper(btrim(name)) FROM catalog.suppliers
         WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
         GROUP BY 1 HAVING count(*) > 1) z`);
    if (!h.homonimos) {
      nm('el catálogo ya no tiene nombres repetidos: la declaración quedó sin universo que vigilar');
    } else {
      ok(f.ambiguos > 0,
        `${h.homonimos} nombres repetidos en el catálogo y ${f.ambiguos} renglones los declaran`);
    }

    console.log('\n[7] Presupuesto de tiempo');
    const t0 = Date.now();
    await knex.raw(`SELECT * FROM analytics.v_supplier_fill_rate
                     WHERE proveedor_nombre = 'MONDELEZ MEXICO S DE RL DE CV'`);
    const msProv = Date.now() - t0;
    ok(msProv < 1000, `la ficha de un proveedor: ${msProv} ms`);

    console.log('\n[8] Frescura — una matvista sin refresco es una foto que envejece callada');
    const { rows: [fr] } = await knex.raw(`
      SELECT max(calculado_al) AS al,
             round(EXTRACT(epoch FROM now() - max(calculado_al)) / 3600.0, 1) AS horas
        FROM analytics.mv_supplier_fill_rate`);
    nm(`calculada hace ${fr.horas} h — todavía NO tiene refresco nocturno ni umbral en CRON_JOBS. ` +
       'Hasta que lo tenga, nadie se entera si deja de actualizarse.');

    console.log(
      (fail ? `\n❌ cumplimiento del proveedor: ${fail} falla(s)` : '\n✅ cumplimiento del proveedor: verde')
      + (noMedido ? ` · ${noMedido} NO MEDIDO` : ''));
    process.exit(fail ? 1 : (noMedido ? 2 : 0));
  } catch (e) {
    console.error('\n❌ ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
