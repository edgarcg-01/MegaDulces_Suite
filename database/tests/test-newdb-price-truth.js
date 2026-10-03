/**
 * `[VPR.1/VPR.2]` — **El precio de venta, resuelto por plaza y fuera del alcance de cualquier escritor.**
 *
 * Nace de *"mencionan desactualización de precios"* en `/vendor/take-order`. Medido contra prod el
 * 2026-10-03, **no era desactualización**: era (a) grano —un solo precio de red donde el ERP tiene
 * uno por plaza— y (b) **dos procesos peleándose la columna**, 302,273 vaivenes en 3 días.
 *
 * ── Lo que este candado vigila NO es el precio ───────────────────────────────────────────────
 * El precio lo dice el ERP. Lo que puede volver mentira a la pantalla son sus premisas:
 *
 * 1. **Que el árbitro discrimine.** Se exige que la ETIQUETERA —que ya tiene grano de sucursal—
 *    siga cuadrando casi perfecto contra el mismo `c90`. Es el control: si ella también se cae,
 *    lo que se rompió es el árbitro, no el vendedor, y la conclusión sería la opuesta.
 * 2. **Que la plaza se resuelva.** El puente es `warehouses.code` = `kdii.sucursal`. Si ese join
 *    se rompe, la vista se queda sin filas y un LEFT JOIN lo serviría como NULL — o sea, en
 *    silencio, volviendo al precio de red sin que nadie se entere.
 * 3. ⭐ **Que NADIE pueda escribir el número publicado.** Es la propiedad que vuelve definitiva a
 *    esta solución, y por eso se prueba ROMPIÉNDOLA: el bloque [3] intenta un UPDATE contra la
 *    vista y exige que Postgres lo rechace. Un gate sin prueba negativa es una intención.
 * 4. **Que el marcador de promo no se publique como precio.** En Kepler los `c90` de $0.01/$0.05
 *    son claves de regalo, no precio.
 * 5. **Que lo que no se puede resolver se DECLARE**, nunca se dibuje como cero.
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
    const existe = (await knex.raw(`SELECT to_regclass('analytics.v_price_truth') AS t`)).rows[0]?.t;
    if (!existe) {
      nm('analytics.v_price_truth no existe (¿migración 20261003160000 pendiente?)');
      console.log('\n⚠️  verdad del precio: NO MEDIDO');
      process.exit(2);
    }

    console.log('\n[1] Forma, grano y cobertura');
    const { rows: [f] } = await knex.raw(`
      SELECT count(*)::int filas, count(DISTINCT warehouse_id)::int plazas,
             count(DISTINCT product_id)::int productos,
             count(*) FILTER (WHERE veredicto='cuadra')::int cuadran,
             count(*) FILTER (WHERE veredicto='difiere')::int difieren,
             round(100.0*count(*) FILTER (WHERE veredicto='cuadra')/NULLIF(count(*),0),1) pct
        FROM analytics.v_price_truth`);
    ok(f.filas > 0, `${f.filas} filas · ${f.plazas} plazas · ${f.productos} productos`);
    // El puente es el CODIGO de almacen. Con una sola plaza resolviendo, la vista ya no es "por
    // plaza" y el LEFT JOIN del servicio devolvería NULL para las demás, cayendo al precio de red.
    ok(f.plazas >= 2, `el join por código de almacén resuelve ${f.plazas} plazas`);

    console.log('\n[2] CONTROL — la etiquetera, que SÍ tiene grano de sucursal, cuadra contra el mismo árbitro');
    // Sin este control, un 86.8% del vendedor podría significar "el ERP está raro" en vez de
    // "la lista de red no puede acertar". La etiquetera decide cuál de las dos lecturas es.
    const { rows: [ctl] } = await knex.raw(`
      WITH ods AS (SELECT btrim(sucursal) suc, upper(btrim(c1)) sku, c90::numeric precio
                     FROM kepler_ods.kdii WHERE c90 IS NOT NULL AND c90::numeric > 0.05)
      SELECT count(*)::int pares,
             count(*) FILTER (WHERE abs(l.piece_price - o.precio) < 0.005)::int cuadran,
             round(100.0*count(*) FILTER (WHERE abs(l.piece_price-o.precio)<0.005)/NULLIF(count(*),0),1) pct
        FROM commercial.product_label_prices l
        JOIN catalog.products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
                               AND p.activo = true AND p.deleted_at IS NULL
        JOIN ods o ON o.sku = upper(btrim(p.sku)) AND o.suc = l.sucursal
       WHERE l.piece_price > 0`);
    if (!ctl.pares) nm('no hay pares etiquetera×ERP comparables: el control no se pudo correr');
    else ok(Number(ctl.pct) >= 99,
      `etiquetera vs ERP: ${ctl.cuadran} de ${ctl.pares} (${ctl.pct}%) — el árbitro sirve, ` +
      'así que el hueco del precio de red es del precio de red');

    console.log('\n[3] ⭐ PRUEBA NEGATIVA — el número publicado NO se puede escribir');
    // Ésta es LA propiedad. La tabla anterior se podía escribir, y por eso dos procesos la
    // pisaron 302,273 veces en 3 días. Si algún día esto dejara de fallar, el defecto volvió.
    let rechazado = false;
    let motivo = '';
    try {
      await knex.raw(`UPDATE analytics.v_price_truth SET precio_erp = precio_erp WHERE false`);
    } catch (e) {
      rechazado = true;
      motivo = (e.message || '').split('\n')[0];
    }
    ok(rechazado, rechazado
      ? `Postgres rechaza escribirla: "${motivo.slice(0, 80)}"`
      : 'LA VISTA ACEPTÓ UNA ESCRITURA — dejó de ser inmune y el defecto puede volver');

    console.log('\n[4] PREMISA — el marcador de promo no se publica como precio');
    const { rows: [pr] } = await knex.raw(`
      SELECT count(*) FILTER (WHERE precio_erp <= 0.05)::int marcadores_publicados,
             count(*) FILTER (WHERE precio_erp IS NULL)::int nulos,
             count(*) FILTER (WHERE precio_erp = 0)::int ceros
        FROM analytics.v_price_truth`);
    ok(pr.marcadores_publicados === 0 && pr.ceros === 0,
      `${pr.marcadores_publicados} precios de $0.05 o menos y ${pr.ceros} en cero (los $0.01/$0.05 ` +
      'de Kepler son claves de regalo, no precio)');
    ok(pr.nulos === 0, `${pr.nulos} filas con precio nulo: lo que no hay no entra, no se dibuja`);

    console.log('\n[5] EL CAMBIO DE NÚMERO — cuántas celdas publican distinto al cablearla');
    const { rows: [d] } = await knex.raw(`
      SELECT count(*)::int celdas,
             count(*) FILTER (WHERE veredicto='difiere')::int cambian,
             count(DISTINCT product_id) FILTER (WHERE veredicto='difiere')::int skus,
             count(*) FILTER (WHERE veredicto='difiere' AND precio_lista < precio_erp)::int cobraba_de_menos,
             -- percentile_cont devuelve double precision y round(double, int) NO existe en
             -- Postgres: el cast a numeric va ANTES del round, no después.
             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY desvio_pct)
                    FILTER (WHERE veredicto='difiere'))::numeric, 2) mediana_desvio_pct
        FROM analytics.v_price_truth`);
    ok(d.cambian > 0,
      `${d.cambian} de ${d.celdas} celdas cambian (${d.skus} SKUs); ${d.cobraba_de_menos} venían ` +
      `cobrando de MENOS; desvío mediano ${d.mediana_desvio_pct}%`);

    console.log('\n[6] La guerra de escritores sobre la tabla vieja (lo que la vista deja de sufrir)');
    const { rows: [g] } = await knex.raw(`
      SELECT count(*)::int vaivenes_24h, count(DISTINCT pk)::int filas,
             count(*) FILTER (WHERE actor IS NULL)::int sin_declarar_actor
        FROM analytics.master_data_history
       WHERE tabla='commercial.product_prices' AND changed_at > now()-interval '24 hours'
         -- jsonb_exists() y NO el operador ?: knex lee el ? como placeholder de binding
         -- (la misma trampa que CLAUDE.md documenta para role_permissions).
         AND jsonb_exists(diff, 'price')`);
    if (!g.vaivenes_24h) {
      nm('no hubo cambios de precio en 24 h: no se puede medir la disputa (¿se detuvo el feed?)');
    } else {
      // No es una falla: es el hecho que justifica la vista. Se DECLARA con su número para que,
      // si alguien apaga al escritor anónimo, se note que bajó en vez de suponerlo.
      console.log(`  ℹ️  ${g.vaivenes_24h} cambios de precio en 24 h sobre ${g.filas} filas · ` +
                  `${g.sin_declarar_actor} sin actor declarado`);
      ok(true, 'la disputa queda medida y declarada, no supuesta');
    }

    console.log('\n[7] Presupuesto de tiempo — el caso real: UNA plaza');
    const { rows: [w] } = await knex.raw(
      `SELECT id::text FROM commercial.warehouses WHERE code='01' AND deleted_at IS NULL LIMIT 1`);
    if (!w) nm('no existe el almacén 01: no se pudo medir el caso de una plaza');
    else {
      const t0 = Date.now();
      await knex.raw(`SELECT count(*) FROM analytics.v_price_truth WHERE warehouse_id = ?`, [w.id]);
      const ms = Date.now() - t0;
      ok(ms < 1000, `el catálogo de una plaza: ${ms} ms`);
    }

    console.log('\n[8] Lo que esta solución NO resuelve');
    nm('Un precio puesto por un HUMANO y uno derivado del ERP viven en la misma columna de ' +
       'commercial.product_prices, y `updated_by` está en 0 de 9,618 — así que un override manual ' +
       'es indistinguible de un feed y esta vista no puede respetarlo. El override necesita ' +
       'columna propia; queda declarado, no resuelto.');

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
