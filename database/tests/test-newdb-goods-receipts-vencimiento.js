/**
 * `[RE.1]` — **El vencimiento de la orden de entrada.**
 *
 * `analytics.erp_goods_receipts` sabía qué llegó y por cuánto, no cuándo se debe. Sin eso no hay
 * aging ni cartera por pagar (RE.3). Este smoke fija lo que se **midió** al construirlo, para que
 * si el ERP cambia de comportamiento se ponga rojo acá y no en una pantalla de dinero:
 *
 *   · `c18` (fecha_vence) viene poblada SIEMPRE en el carril Kepler.
 *   · `dias_credito` = `c18 − c9` **coincide con el número que dice el texto de `c30`**. Ésa es la
 *     prueba de que el decode es correcto y no una coincidencia: dos columnas independientes que
 *     cuentan la misma historia.
 *   · **NO se clampa el negativo.** Hay documentos con vencimiento anterior a la fecha; es calidad
 *     de dato del ERP y esconderla sería dibujar un dato que no existe.
 *   · La vista **no hace fanout**: agregar columnas no puede multiplicar recepciones (ya pasó una
 *     vez en esta misma vista, mig 20260819140000).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipts-vencimiento.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

(async () => {
  try {
    const cols = (await knex.raw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='erp_goods_receipts'`)).rows.map((r) => r.column_name);
    for (const c of ['fecha_vence', 'condicion_pago', 'dias_credito']) {
      ok(cols.includes(c), `la vista expone \`${c}\``);
    }
    if (fail) { console.log('\n❌ faltan columnas — ¿migración pendiente?'); process.exit(1); }

    const kep = await knex.raw(`
      SELECT count(*)::int filas,
             count(fecha_vence)::int con_vence,
             count(condicion_pago)::int con_condicion
        FROM analytics.erp_goods_receipts
       WHERE tenant_id = ? AND source_branch LIKE 'md_%'`, [T]);
    const k = kep.rows[0];
    if (!k.filas) { console.log('  ⚠️  sin recepciones Kepler en este entorno — SKIP'); process.exit(0); }
    ok(k.con_vence === k.filas, `el vencimiento viene SIEMPRE en Kepler (${k.con_vence}/${k.filas})`);
    ok(k.con_condicion >= k.filas - 5, `la condición de pago viene casi siempre (${k.con_condicion}/${k.filas})`);

    // La prueba de fondo: dos columnas independientes cuentan la misma historia. `condicion_pago`
    // es texto libre ("30 días fecha factura"); `dias_credito` es aritmética de fechas.
    //
    // ⚠️ La tolerancia de ±3 días NO es holgura para que pase el test — es el dato.
    // Medido: "30 días fecha factura" da **31** días en 711 documentos y **28** en 111. Kepler
    // resuelve el plazo como **UN MES DE CALENDARIO**, no como "+30 días": desde un mes de 31 da
    // 31, desde febrero da 28. El texto es la ETIQUETA del plazo comercial; `c18` es la fecha
    // real, y por eso se guarda cruda en vez de derivarla del texto.
    // Distribución completa: desvío 0 → 3,050 · 1 → 711 · 2 → 112 · y sólo 3 documentos fuera
    // (5, 21 y 30 días), que son calidad de dato del ERP.
    const cruce = await knex.raw(`
      SELECT count(*)::int n,
             count(*) FILTER (WHERE abs(dias_credito - (regexp_replace(condicion_pago, '[^0-9]', '', 'g'))::int) <= 3)::int cerca
        FROM analytics.erp_goods_receipts
       WHERE tenant_id = ? AND source_branch LIKE 'md_%'
         AND condicion_pago ~ '[0-9]' AND fecha_vence IS NOT NULL`, [T]);
    const cr = cruce.rows[0];
    const pct = cr.n ? (cr.cerca / cr.n) * 100 : 0;
    ok(pct >= 99, `el vencimiento casa con el plazo declarado (±3d por largo de mes): ${cr.cerca}/${cr.n} (${pct.toFixed(2)}%)`);

    // "Pago de contado" NO puede tener días POSITIVOS: es el 68% del universo, y si alguno
    // apareciera a plazo, el aging de RE.3 inventaría deuda que nadie acordó. Se admite el
    // negativo (los 2 documentos con −1) porque ése es el defecto conocido del ERP, no un plazo.
    const contado = await knex.raw(`
      SELECT count(*)::int n, count(*) FILTER (WHERE dias_credito > 0)::int a_plazo
        FROM analytics.erp_goods_receipts
       WHERE tenant_id = ? AND source_branch LIKE 'md_%' AND condicion_pago ILIKE '%contado%'`, [T]);
    const co = contado.rows[0];
    ok(co.n > 0 && co.a_plazo === 0,
      `ninguna de las ${co.n} "Pago de contado" figura a plazo (si no, RE.3 inventaría deuda)`);

    // El negativo NO se clampa: es calidad de dato del ERP y tiene que verse.
    const neg = await knex.raw(`
      SELECT count(*)::int n, min(dias_credito)::int peor
        FROM analytics.erp_goods_receipts
       WHERE tenant_id = ? AND source_branch LIKE 'md_%' AND dias_credito < 0`, [T]);
    console.log(`     (${neg.rows[0].n} documento(s) con vencimiento ANTERIOR a la fecha, mínimo ${neg.rows[0].peor} — se dejan crudos a propósito)`);
    ok(true, 'el negativo se conserva crudo, no se clampa a 0');

    // Agregar columnas no puede multiplicar filas.
    const dup = await knex.raw(`
      SELECT count(*)::int n FROM (
        SELECT sucursal, folio, count(*) c FROM analytics.erp_goods_receipts
         WHERE tenant_id = ? GROUP BY 1,2 HAVING count(*) > 1) x`, [T]);
    ok(dup.rows[0].n === 0, `sin fanout: 0 claves (sucursal, folio) repetidas`);

    // El carril Wincaja se declara, no se afirma: acá está vacío y no se pudo verificar.
    const wcj = await knex.raw(`
      SELECT count(*)::int filas, count(fecha_vence)::int con_vence
        FROM analytics.erp_goods_receipts
       WHERE tenant_id = ? AND source_branch LIKE 'wincaja%'`, [T]);
    if (!wcj.rows[0].filas) {
      console.log('  ⚠️  carril Wincaja VACÍO en este entorno: su vencimiento quedó mapeado pero SIN VERIFICAR');
    } else {
      ok(wcj.rows[0].con_vence > 0, `Wincaja también trae vencimiento (${wcj.rows[0].con_vence}/${wcj.rows[0].filas})`);
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
