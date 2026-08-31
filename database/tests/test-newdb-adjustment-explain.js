/**
 * `[RE.21]` — **Explicar el descuadre por MONTO, porque no hay llave.**
 *
 * El cuadre de una factura de entrada es de 2 vías (lo que leyó el OCR vs el valor Kepler) e
 * ignora los ajustes de compra. Al querer arreglarlo, medido sobre `kepler_ods.kdm1`:
 *
 *   - `entrada_folio` (c39) liga el **4%** de los ajustes. En las **X-D-55 liga 0 de 1,256**,
 *     y las notas de crédito son el 90% del dinero.
 *   - `factura_ref` (c11) NO es una referencia de factura pese al nombre que le puso el
 *     importer: el **29% trae el CÓDIGO DE PROVEEDOR** (`= c10`), otra parte trae destinos
 *     (`DP-0CEDIS`), y sólo el **13%** son dígitos que podrían ser un folio.
 *
 * O sea: **no existe llave estructural** entre la nota de crédito y la recepción. Lo único
 * defendible es lo que haría una persona — buscar candidatos del proveedor y ver cuál tiene el
 * **tamaño del hueco** — y dejar el dictamen en el humano (ADR-016).
 *
 * Este smoke fija las premisas de datos de las que depende ese diseño. Si alguna cambia (Kepler
 * empieza a ligar, o `c11` se vuelve confiable), hay que rediseñar y conviene enterarse acá.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-adjustment-explain.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

(async () => {
  try {
    const ods = Number((await knex.raw(
      `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'kepler_ods'`)).rows[0].n);
    if (!ods) { console.log('  ⚠️  sin kepler_ods en esta base — SKIP'); process.exit(0); }

    const AJ = `FROM kepler_ods.kdm1 WHERE c2='X' AND c3='D' AND trim(c4::text) IN ('40','55')`;
    const [t] = (await knex.raw(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE NULLIF(btrim(c39),'') IS NOT NULL)::int con_entrada,
             count(*) FILTER (WHERE trim(c4::text)='55')::int n55,
             count(*) FILTER (WHERE trim(c4::text)='55' AND NULLIF(btrim(c39),'') IS NOT NULL)::int n55_ligadas,
             count(*) FILTER (WHERE NULLIF(btrim(c11),'') IS NOT NULL)::int con_c11,
             count(*) FILTER (WHERE btrim(c11) = btrim(c10))::int c11_es_proveedor,
             count(*) FILTER (WHERE btrim(c11) ~ '^[0-9]+$')::int c11_digitos
        ${AJ}`)).rows;
    if (!t.total) { console.log('  ⚠️  sin ajustes X-D-40/55 en el ODS — SKIP'); process.exit(0); }
    console.log(`\n  ${t.total} ajustes en el ODS (X-D-40 + X-D-55)\n`);

    // 1. La liga por folio de entrada NO alcanza — es la premisa que obliga al match por monto.
    ok(pct(t.con_entrada, t.total) < 25,
      `la liga por entrada_folio cubre poco: ${t.con_entrada}/${t.total} (${pct(t.con_entrada, t.total)}%)`);

    // 2. Y en las notas de crédito —el 90% del dinero— no liga nada. Si esto deja de ser cierto,
    //    conviene volver al join exacto para ellas.
    ok(t.n55_ligadas === 0,
      t.n55_ligadas === 0
        ? `las X-D-55 NUNCA ligan por entrada_folio (0 de ${t.n55}) — por eso el match es por monto`
        : `¡Kepler empezó a ligar X-D-55! ${t.n55_ligadas} de ${t.n55} → revisar si conviene el join exacto`);

    // 3. `c11` no sirve de llave pese a llamarse `factura_ref`. La aserción está escrita como
    //    "no es confiable", no como "es basura": si algún día se limpia, se pone roja y se revisa.
    ok(t.c11_es_proveedor > 0 && pct(t.c11_digitos, t.con_c11) < 40,
      `factura_ref (c11) NO es llave: ${t.c11_es_proveedor} traen el código de proveedor y sólo ${t.c11_digitos}/${t.con_c11} (${pct(t.c11_digitos, t.con_c11)}%) son dígitos`);

    // 4. El timing: el ajuste llega DESPUÉS, así que el cuadre calculado al capturar es una foto.
    const [ti] = (await knex.raw(`
      WITH aj AS (SELECT c1 suc, btrim(c39) fol, c9::date f ${AJ} AND NULLIF(btrim(c39),'') IS NOT NULL)
      SELECT count(*)::int n,
             count(*) FILTER (WHERE aj.f > e.receipt_date)::int posterior,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY aj.f - e.receipt_date) p50
        FROM aj JOIN analytics.erp_goods_receipts e
          ON e.sucursal = aj.suc AND e.folio = aj.fol AND e.dup_of_folio IS NULL`)).rows;
    if (Number(ti.n) > 0) {
      ok(true, `timing: ${ti.posterior}/${ti.n} (${pct(ti.posterior, ti.n)}%) llegan DESPUÉS de la recepción, mediana ${ti.p50}d → el cuadre al capturar es una foto`);
    } else console.log('     (ninguno liga a una entrada del espejo: sin muestra de timing)');

    // 5. La dirección contable NO es estable: si lo fuera, se podría restar y afirmar. Va del
    //    8% al 100% de la entrada, así que el motor compara MAGNITUDES y no signos.
    const [d] = (await knex.raw(`
      WITH aj AS (SELECT c1 suc, btrim(c39) fol, c16::numeric m ${AJ} AND NULLIF(btrim(c39),'') IS NOT NULL)
      SELECT count(*)::int n,
             min(round(100*aj.m/NULLIF(e.monto::numeric,0)))::int min_pct,
             max(round(100*aj.m/NULLIF(e.monto::numeric,0)))::int max_pct,
             count(*) FILTER (WHERE abs(aj.m - e.monto::numeric) < 1)::int reversion_total
        FROM aj JOIN analytics.erp_goods_receipts e
          ON e.sucursal = aj.suc AND e.folio = aj.fol AND e.dup_of_folio IS NULL
       WHERE e.monto::numeric > 0`)).rows;
    if (Number(d.n) > 0) {
      ok(Number(d.max_pct) - Number(d.min_pct) > 20,
        `el ajuste va del ${d.min_pct}% al ${d.max_pct}% de la entrada (${d.reversion_total} son la recepción entera revertida) → no hay regla de signo, se comparan magnitudes`);
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
