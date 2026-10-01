/* eslint-disable no-console */
/**
 * `[DM.17]` CANDADO del ORIGEN REAL de un traspaso.
 *
 * ── QUÉ PROTEGE ─────────────────────────────────────────────────────────────────────────────
 * Que un traspaso que Kepler registró en la sucursal `00` no se publique como "CEDIS" cuando el
 * origen físico fue otra plaza. Reportado por Edgar el 2026-10-01 (*"antes al 9.95 se subían
 * CEDIS y Morelia Abastos"*) y confirmado con un ticket impreso.
 *
 * ── ⭐ EL CONTROL QUE HACE ÚNICO A ESTE CASO ────────────────────────────────────────────────
 * El folio de ticket `T990008354` existe en DOS ramas Wincaja, y las dos se cargaron a la MISMA
 * sucursal de Kepler (`00`). Es un par control natural: mismo folio, mismo destino, veredictos
 * OPUESTOS, y lo único que los separa es el contenido.
 *
 *   folio 0000712 · 24-sep · 90041 ×48 + 90044 ×15 · $1,407.42 → rama 30 Abastos → `otra_plaza`
 *   folio 0000757 · 29-sep · 99218 ×100            · $2,668.00 → rama 00 CEDIS   → `origen_confirmado`
 *
 * Un detector que marcara los dos igual se vería igual de verde que uno que discrimina. Por eso
 * el bloque 2 exige los DOS veredictos, no sólo el "malo".
 *
 * ── LO QUE SE VERIFICA ──────────────────────────────────────────────────────────────────────
 *  1. La vista existe, tiene `security_invoker` y su GRANT (tras un CREATE OR REPLACE no se
 *     heredan — ya se perdió una vez en este repo).
 *  2. CONTROL POSITIVO + NEGATIVO con el par de `T990008354`.
 *  3. El desambiguador es el CONTENIDO, no el importe: se mide que por importe el caso del
 *     29-sep NO resolvería (Kepler $2,668.00 contra Wincaja $1,533.34) y por SKU+cantidad sí.
 *  4. La COBERTURA se declara, siempre. Sin esto, "567 fuera de réplica" se lee igual que
 *     "567 están bien" (ADR-056).
 *  5. El índice que sostiene el costo sigue existiendo.
 *
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-transfer-true-origin.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TICKET = 'T990008354';

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  try {
    await db.query(`SET statement_timeout = '180s'`);
    console.log(`\n[DM.17] Origen real de un traspaso · ${(await q('SELECT current_database() d'))[0].d}`);

    // ── 1. La vista existe, con security_invoker y GRANT ──────────────────────────────────
    console.log('\n[1] La vista existe, es security_invoker y app_runtime la puede leer');
    const [meta] = await q(
      `SELECT c.relname,
              EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o
                       WHERE o.option_name='security_invoker' AND o.option_value='true') AS inv,
              has_table_privilege('app_runtime', c.oid, 'SELECT') AS grant_ok
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='analytics' AND c.relname='v_transfer_true_origin'`);
    if (!meta) { bad('analytics.v_transfer_true_origin NO existe: falta la migración 20261001220000.'); }
    else {
      // Los dos juntos: un CREATE OR REPLACE VIEW no hereda ni la opción ni el permiso, y la
      // omisión no se nota hasta que alguien abre la pantalla con el rol de la app.
      if (meta.inv && meta.grant_ok) pass('existe, security_invoker = true y app_runtime tiene SELECT.');
      else bad(`security_invoker=${meta.inv} · grant app_runtime=${meta.grant_ok} (los dos se pierden en un CREATE OR REPLACE).`);
    }

    // ── 2. CONTROL POSITIVO + NEGATIVO con el par del mismo folio ─────────────────────────
    console.log(`\n[2] El par de ${TICKET}: mismo folio de ticket, veredictos opuestos`);
    const par = await q(
      `SELECT folio, doc_date::text AS f, origen_veredicto, origen_rama_wincaja, importe
         FROM analytics.v_transfer_true_origin
        WHERE ticket_ref = $1 ORDER BY doc_date`, [TICKET]);
    if (!par.length) {
      skip(`no hay documentos con ticket_ref = ${TICKET}: el caso control no está en esta base.`);
    } else {
      par.forEach((r) => console.log(`     ${r.folio} · ${r.f} · ${r.origen_veredicto}`
        + `${r.origen_rama_wincaja ? ' → rama ' + r.origen_rama_wincaja : ''} · ${money(r.importe)}`));
      const abastos = par.find((r) => r.folio === '0000712');
      const cedis = par.find((r) => r.folio === '0000757');
      if (!abastos || !cedis) {
        skip(`esperaba los folios 0000712 y 0000757; llegaron ${par.map((r) => r.folio).join(', ')}.`);
      } else if (abastos.origen_veredicto === 'otra_plaza' && abastos.origen_rama_wincaja === '30'
              && cedis.origen_veredicto === 'origen_confirmado' && cedis.origen_rama_wincaja === '00') {
        pass('marca el de Morelia Abastos (30) y NO marca el del CEDIS (00): discrimina por contenido.');
      } else if (abastos.origen_veredicto !== 'otra_plaza') {
        bad(`el documento de Morelia Abastos salió "${abastos.origen_veredicto}"`
          + `${abastos.origen_rama_wincaja ? ' rama ' + abastos.origen_rama_wincaja : ''}: el detector no ve el caso que lo originó.`);
      } else {
        bad(`el documento del CEDIS salió "${cedis.origen_veredicto}"`
          + `${cedis.origen_rama_wincaja ? ' rama ' + cedis.origen_rama_wincaja : ''}: marca de más, daría falsos positivos.`);
      }
    }

    // ── 3. El desambiguador es el CONTENIDO, no el importe ────────────────────────────────
    console.log('\n[3] Por importe NO alcanza — por eso se desambigua con sku + cantidad');
    const [imp] = await q(
      `WITH k AS (
         SELECT m.c6 AS folio, m.c16::numeric AS imp FROM kepler_ods.kdm1 m
          WHERE m.c24 = $1 AND m.c2='U' AND m.c3='D' AND m.c4=41 AND m.c6='0000757'),
       w AS (
         SELECT sum(d.valor_venta)::numeric AS venta
           FROM wincaja.maestro_mov_almacen mm
           JOIN wincaja.detalles_mov_almacen d
             ON d.tenant_id=mm.tenant_id AND d.source_branch=mm.source_branch
            AND d.source_dataset=mm.source_dataset AND d.consecutivo=mm.consecutivo
          WHERE mm.documento = $1 AND mm.source_branch='00')
       SELECT k.imp AS kepler, w.venta AS wincaja, abs(k.imp - w.venta) AS delta FROM k, w`, [TICKET]);
    if (!imp || imp.wincaja === null) {
      skip('no se pudo medir la diferencia de importe del caso del 29-sep.');
    } else if (Number(imp.delta) > 1.0) {
      pass(`Kepler ${money(imp.kepler)} contra Wincaja ${money(imp.wincaja)} = ${money(imp.delta)} de diferencia:`
        + ' el importe habría perdido este match, el contenido no.');
    } else {
      bad(`la diferencia es ${money(imp.delta)}: el importe habría bastado y esta prueba ya no demuestra nada`
        + ' — revisar si el argumento del desambiguador sigue en pie.');
    }

    // ── 4. La cobertura SIEMPRE en pantalla ───────────────────────────────────────────────
    console.log('\n[4] Cobertura declarada (lo que no se puede medir no se da por bueno)');
    const cob = await q(
      `SELECT origen_veredicto, count(*)::int n, sum(importe) imp
         FROM analytics.v_transfer_true_origin GROUP BY 1 ORDER BY 2 DESC`);
    if (!cob.length) { skip('la vista no devolvió filas.'); }
    else {
      const tot = cob.reduce((s, r) => s + r.n, 0);
      cob.forEach((r) => console.log(`     ${String(r.origen_veredicto).padEnd(24)} ${String(r.n).padStart(5)}  ${money(r.imp)}`));
      const fuera = cob.find((r) => r.origen_veredicto === 'ticket_fuera_de_replica');
      const pct = fuera ? 100 * fuera.n / tot : 0;
      const otra = cob.find((r) => r.origen_veredicto === 'otra_plaza');
      console.log(`     → ${pct.toFixed(1)}% NO es verificable: su ticket no está en la réplica Wincaja.`);
      console.log('       Eso es un hueco de DATOS, no un veredicto de que estén bien.');
      if (otra) {
        console.log(`     → ${otra.n} documento(s) por ${money(otra.imp)} NO salieron de la sucursal que Kepler dice.`);
      }
      // No se exige un umbral de cobertura: hoy es baja y bajarla a un número "aceptable"
      // sería inventar. Lo que se exige es que el bucket EXISTA y se reporte.
      pass(`los ${tot} documentos están clasificados y la cobertura se publica (${pct.toFixed(1)}% no verificable).`);
    }

    // ── 5. El índice que sostiene el costo ────────────────────────────────────────────────
    console.log('\n[5] El índice por documento sigue existiendo');
    const [idx] = await q(
      `SELECT 1 FROM pg_indexes WHERE schemaname='wincaja' AND indexname='ix_wcj_maestro_documento'`);
    if (idx) pass('ix_wcj_maestro_documento presente (sin él la resolución pasa de ~1.5 s a 4.2 s).');
    else bad('falta ix_wcj_maestro_documento: la vista se vuelve un seq scan de 1.5 M filas.');

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
