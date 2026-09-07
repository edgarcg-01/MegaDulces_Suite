/**
 * `[RE.22.1]` — **El desglose de un ajuste, y sobre todo cuándo NO hay desglose.**
 *
 * La lista de ajustes de una entrada decía CUÁNTO se ajustó y nunca QUÉ. Los renglones viven en
 * `kepler_ods.kdm2` y ahora se sirven por la vista `analytics.erp_purchase_adjustment_lines`.
 *
 * Lo que este smoke fija no es "la vista devuelve filas" —eso es lo fácil— sino **la asimetría
 * del negocio**, que es lo que se puede romper en silencio:
 *
 *   · `X-D-40` devolución  → SÍ trae renglones (mercancía que se regresó).
 *   · `X-D-55` nota de crédito → NO trae renglones **en Kepler**, y eso es CORRECTO: una nota es
 *     dinero, no mercancía (sus motivos son "3% PP a 48 hrs", "DESCUENTO DEL 5%"). Son 1,256
 *     documentos y $21.4M sin una sola línea.
 *
 * Si alguien "arregla" esto tratando la lista vacía como falta de datos, la pantalla va a decir
 * que falta información donde no falta — sobre el 90% del dinero de los ajustes. Por eso el
 * contrato tiene TRES valores y no dos, y por eso se afirma acá.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-adjustment-lines.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** Réplica del clasificador de `PurchaseAdjustmentsService.lines()`. */
const clasifica = (doctype, nLineas) =>
  nLineas > 0 ? 'renglones' : doctype === 'XD55' ? 'no_aplica' : 'sin_dato';

(async () => {
  try {
    const existe = (await knex.raw(
      `SELECT to_regclass('analytics.erp_purchase_adjustment_lines') AS t`)).rows[0]?.t;
    if (!existe) { console.log('  ⚠️  sin la vista de renglones (¿migración pendiente?) — SKIP'); process.exit(0); }

    const kind = (await knex.raw(
      `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_purchase_adjustment_lines')`)).rows[0].relkind;
    ok(kind === 'v', `es VISTA y no tabla copiada (relkind=${kind}) — derive-no-copy`);

    // 1. Las devoluciones sí traen renglones.
    const xd40 = (await knex.raw(`
      SELECT count(*)::int lineas, count(DISTINCT (sucursal, folio))::int docs
        FROM analytics.erp_purchase_adjustment_lines WHERE tenant_id = ? AND doctype = 'XD40'`, [T])).rows[0];
    ok(xd40.lineas > 0, `las devoluciones X-D-40 traen renglones (${xd40.lineas} en ${xd40.docs} documentos)`);

    // 2. **El corazón del asunto**: las notas de crédito NO traen renglones, y hay muchas.
    //    Se afirma contra kdm1 para distinguir "no tienen desglose" de "no hay notas acá".
    const cab55 = (await knex.raw(`
      SELECT count(*)::int docs FROM kepler_ods.kdm1
       WHERE btrim(c2::text)='X' AND btrim(c3::text)='D' AND btrim(c4::text)='55'`)).rows[0];
    const lin55 = (await knex.raw(`
      SELECT count(*)::int lineas FROM analytics.erp_purchase_adjustment_lines
       WHERE tenant_id = ? AND doctype = 'XD55'`, [T])).rows[0];
    ok(cab55.docs > 0, `hay notas de crédito en el ERP (${cab55.docs} encabezados) — el 0 de abajo significa algo`);
    ok(lin55.lineas === 0,
      `las notas de crédito NO se desglosan por producto (${lin55.lineas} renglones sobre ${cab55.docs} documentos)`);
    ok(clasifica('XD55', lin55.lineas) === 'no_aplica',
      'una nota sin renglones se clasifica `no_aplica` (es correcto), NO `sin_dato` (faltaría info)');
    ok(clasifica('XD40', 0) === 'sin_dato',
      'una DEVOLUCIÓN sin renglones sí es `sin_dato`: esa sí debería traer desglose');
    ok(clasifica('XD40', 3) === 'renglones', 'con renglones se clasifica `renglones`');

    // 3. Anti-réplica: cada DB de sucursal arrastra copias de las otras. Sin el filtro
    //    `c1 = sucursal` el mismo renglón sale N veces y el importe se multiplica.
    const dup = (await knex.raw(`
      SELECT count(*)::int n FROM (
        SELECT sucursal, doctype, folio, linea FROM analytics.erp_purchase_adjustment_lines
         WHERE tenant_id = ? GROUP BY 1,2,3,4 HAVING count(*) > 1) x`, [T])).rows[0];
    ok(dup.n === 0, `la anti-réplica sostiene: 0 claves (sucursal,doctype,folio,línea) repetidas`);

    // 4. El nº de línea es TEXTO en Kepler: ordenarlo como texto pone "10" antes que "2".
    const doc = (await knex.raw(`
      SELECT sucursal, folio FROM analytics.erp_purchase_adjustment_lines
       WHERE tenant_id = ? GROUP BY 1,2 HAVING count(*) > 1 LIMIT 1`, [T])).rows[0];
    if (doc) {
      const ls = await knex('analytics.erp_purchase_adjustment_lines')
        .where({ tenant_id: T, sucursal: doc.sucursal, folio: doc.folio })
        .orderByRaw(`NULLIF(regexp_replace(linea, '[^0-9]', '', 'g'), '')::int NULLS LAST, linea`)
        .pluck('linea');
      const nums = ls.map((l) => parseInt(String(l).replace(/[^0-9]/g, ''), 10)).filter(Number.isFinite);
      ok(nums.every((v, i) => i === 0 || nums[i - 1] <= v),
        `el nº de línea se ordena por su valor numérico y no como texto (${ls.join(',')})`);
    } else {
      console.log('  ⚠️  sin documentos multi-renglón para probar el orden — se omite');
    }

    // 5. El patrón REAL de la pantalla (un documento) tiene que ser barato: es un clic.
    const uno = (await knex.raw(`
      SELECT sucursal, folio FROM analytics.erp_purchase_adjustment_lines
       WHERE tenant_id = ? LIMIT 1`, [T])).rows[0];
    const t0 = Date.now();
    await knex('analytics.erp_purchase_adjustment_lines')
      .where({ tenant_id: T, sucursal: uno.sucursal, folio: uno.folio }).limit(200);
    const ms = Date.now() - t0;
    ok(ms < 1000, `un documento se abre en ${ms} ms (< 1s: es un clic, no un reporte)`);

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
