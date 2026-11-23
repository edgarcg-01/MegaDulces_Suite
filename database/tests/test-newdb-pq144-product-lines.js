/* eslint-disable no-console */
/**
 * `[PQ.144]` LA CLASIFICACIÓN DEL PRODUCTO (línea = fabricante, tipo, grupo) — contra prod, SÓLO
 * LECTURA, con el SQL de la PROPIA migración.
 *
 * El SQL no se copia: se **extrae** del archivo de migración y se monta como vista temporal. Si
 * alguien cambia la vista, esta prueba mide la nueva — no una copia que se quedó vieja.
 *
 *   1. ⭐ CONTROL contra un hecho independiente: el SKU `63018` tiene que dar
 *      `BIMBO SA DE CV / DULCES / CHOCOLATE GALLETA`, que es **lo que muestra la pantalla del
 *      ERP** (`pv_cat_prod_pos.kpl`, capturada por el PM el 2026-11-22). Sin este control el
 *      decode se estaría verificando contra sí mismo.
 *   2. No se pierde ningún SKU por el `JOIN` a `commercial.warehouses`: lo que entra, sale.
 *   3. La cobertura de línea se MIDE y se declara (no se asume el 100 %).
 *   4. El tamaño de las líneas sostiene el corte de 70 renglones.
 *   5. NEGATIVA: un SKU con código de línea que el catálogo no resuelve sale `sin_linea = true`
 *      y **no desaparece** de la vista.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const LF = String.fromCharCode(10);
const MIG = path.join(__dirname, '..', 'migrations-newdb', '20261122232136_pq144_v_erp_product_lines.js');
const TOPE_RENGLONES = 70;

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
let knex;
const salir = async () => {
  if (knex) await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

/** El cuerpo del SELECT de la vista, tal como vive en la migración. */
function sqlDeLaMigracion() {
  const txt = fs.readFileSync(MIG, 'utf8');
  const m = txt.match(/CREATE OR REPLACE VIEW analytics\.v_erp_product_lines\s+WITH \(security_invoker = true\) AS([\s\S]*?)`\);/);
  if (!m) throw new Error('no se pudo extraer el SELECT de la migración (¿cambió su forma?)');
  return m[1].trim();
}

knex = require('knex')(require('../knexfile-newdb.js').development);
const soloLectura = (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 120000');
  return fn(trx);
});

(async () => {
  console.log('\n[PQ.144] La línea del producto sale del ODS, derivada — prod, sólo lectura\n');

  let cuerpo;
  try { cuerpo = sqlDeLaMigracion(); } catch (e) { noMedido(e.message); return salir(); }
  /**
   * El MISMO texto de la vista, montado como CTE. ⚠️ No se usa `CREATE TEMP VIEW`: una
   * transacción de sólo lectura no admite crear objetos, y bajarle el `READ ONLY` para una prueba
   * sería quitarle justo la garantía que la hace segura contra prod.
   */
  const conVista = (sql) => soloLectura((trx) => trx.raw(`WITH v_lineas AS (${cuerpo})${LF}${sql}`));

  // 1 ── El control. Si esto falla, el decode está mal y lo demás no se puede creer.
  const c = (await conVista(
    `SELECT linea, tipo, grupo FROM v_lineas WHERE sku = '63018' AND suc_code = '08'`)).rows[0];
  ok(c?.linea === 'BIMBO SA DE CV' && c?.tipo === 'DULCES' && c?.grupo === 'CHOCOLATE GALLETA',
    `CONTROL contra la pantalla del ERP: 63018 → ${c?.linea} / ${c?.tipo} / ${c?.grupo}`);

  // 2 ── El JOIN a warehouses no puede perder SKUs del ODS.
  const p = (await conVista(`
    , ods AS (
      SELECT count(*) n FROM kepler_ods.kdii i
       WHERE btrim(coalesce(i.c1,'')) <> ''
         AND btrim(i.sucursal) IN (SELECT btrim(kepler_code) FROM commercial.warehouses
                                    WHERE deleted_at IS NULL AND kepler_code IS NOT NULL)
    ), vista AS (SELECT count(*) n FROM v_lineas)
    SELECT ods.n AS en_ods, vista.n AS en_vista FROM ods, vista`)).rows[0];
  ok(Number(p.en_vista) === Number(p.en_ods),
    `no se pierde ningún SKU por el JOIN: ${p.en_vista} en la vista = ${p.en_ods} en el ODS`);

  // 3 ── La cobertura se mide y se declara.
  const cob = (await conVista(`
    SELECT count(*) skus, count(*) FILTER (WHERE sin_linea) sin_linea,
           count(DISTINCT linea) lineas
      FROM v_lineas WHERE suc_code = '08'`)).rows[0];
  const pct = (100 * Number(cob.sin_linea) / Number(cob.skus)).toFixed(1);
  ok(Number(cob.skus) > 0 && Number(cob.lineas) > 0,
    `Morelia Abastos: ${cob.skus} SKUs · ${cob.lineas} líneas · ${cob.sin_linea} sin línea (${pct} %)`);
  ok(Number(cob.sin_linea) > 0,
    `y los que no resuelven NO desaparecen: se declaran con sin_linea (${cob.sin_linea})`);

  // 4 ── El tamaño de las líneas sostiene el corte.
  const t = (await conVista(`
    , x AS (SELECT linea, count(*) n FROM v_lineas WHERE suc_code = '08' AND NOT sin_linea GROUP BY 1)
    SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) p50,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY n) p90,
           max(n) max, count(*) FILTER (WHERE n > ${TOPE_RENGLONES}) pasan_el_tope FROM x`)).rows[0];
  ok(Number(t.p50) <= TOPE_RENGLONES,
    `la línea mediana (${t.p50} SKUs) entra holgada en un pedido de ${TOPE_RENGLONES}: p90 ${t.p90}, máx ${t.max}`);
  console.log(`  ·  ${t.pasan_el_tope} línea(s) pasan de ${TOPE_RENGLONES} SKUs por sí solas: ésas NO se parten, se avisan`);

  // 5 ── NEGATIVA: un código de línea huérfano sale declarado, no omitido.
  const h = (await conVista(`
    SELECT count(*) n FROM v_lineas
     WHERE suc_code = '08' AND linea_code IS NOT NULL AND linea IS NULL AND sin_linea IS TRUE`)).rows[0];
  if (Number(h.n) > 0) {
    ok(true, `NEGATIVA: ${h.n} SKU(s) con código de línea que el catálogo no resuelve siguen en la vista, marcados`);
  } else {
    noMedido('no hay ningún código de línea huérfano en Morelia Abastos: la negativa no se pudo ejercer');
  }

  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
