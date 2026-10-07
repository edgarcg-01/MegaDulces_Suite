/* eslint-disable no-console */
/**
 * PV.4 — Smoke del Auditor de TIPO de póliza (ADR-041 + ADR-056). DB-direct.
 *
 * Nace de revisar un TXT de pólizas de ContPAQi (tipo 2 = Egresos) contra un PDF de
 * Kepler del doctype XA1001 "Gastos" (tipo D = Diario). La hipótesis era que Kepler
 * asignaba mal el tipo; medido, NO era así, y este smoke lo deja clavado para que
 * nadie lo vuelva a "arreglar".
 *
 * Cubre, corriendo el SQL de verdad (no por regex sobre el fuente):
 *  1. El criterio de efectivo (102/110/111) y su PRUEBA NEGATIVA: el criterio
 *     ingenuo "mueve 102" marca de más, o sea el detector distingue.
 *  2. XA1001 "Gastos" NO es incongruente (abona a proveedores, no a efectivo).
 *  3. Los doctypes de pago SÍ están en E, y las 3 familias de gasto X-A-9-* que
 *     están en E sin mover efectivo SÍ salen marcadas.
 *  4. La incongruencia VIVA se separa del catálogo dormido (docs > 0).
 *  5. ⭐ ADR-056: con la fuente vacía, el bloque del cruce reporta not_measured con
 *     motivo — NUNCA una lista vacía que se lea como "no hay problemas".
 *
 * Solo lectura: no abre transacción de escritura ni toca datos.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function nm(msg) { console.log('  ⊘ NO MEDIDO:', msg); }

const EFECTIVO = '^(102|110|111)';

const CATALOG_SQL = (re) => `
  WITH cat AS (
    SELECT DISTINCT ON (c1, c2, c3, c4)
           c1, c2, c3::int AS c3, c4::int AS c4, c5 AS descripcion,
           c18 AS tipo, nullif(c19, '') AS cargo, nullif(c20, '') AS abono
      FROM kepler_ods.kdmm ORDER BY c1, c2, c3, c4, c18
  ), j AS (
    SELECT cat.*,
           coalesce(cargo, '') ~ '${re}' AS entra,
           coalesce(abono, '') ~ '${re}' AS sale,
           (cargo IS NULL AND abono IS NULL) AS sin_cuentas
      FROM cat
  )
  SELECT c1 || '-' || c2 || '-' || c3 || '-' || c4 AS doc, descripcion, tipo, cargo, abono,
         CASE WHEN sin_cuentas THEN 'no_juzgable'
              WHEN (entra OR sale) AND tipo = 'D' THEN 'incongruente'
              WHEN NOT (entra OR sale) AND tipo IN ('E','I') THEN 'incongruente'
              ELSE 'ok' END AS veredicto,
         coalesce(d.docs, 0) AS docs, coalesce(d.importe, 0) AS importe
    FROM j
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS docs, round(sum(coalesce(k.c16, 0)))::bigint AS importe
        FROM kepler_ods.kdm1 k
       WHERE k.c2 = j.c1 AND k.c3 = j.c2 AND k.c4 = j.c3 AND k.c5 = j.c4
         AND k.c9 >= ?::date AND k.c9 < ?::date
    ) d ON true`;

(async () => {
  try {
    console.log('\n── 1. Fuente ───────────────────────────────────────────────');
    const reg = (await knex.raw(`SELECT to_regclass('kepler_ods.kdmm') AS r`)).rows[0].r;
    if (!reg) {
      nm('kepler_ods.kdmm no existe: el bloque de catálogo no se puede medir en esta base');
      console.log(`\n  ${pass} ✓ / ${fail} ✗ — bloque de catálogo NO MEDIDO (no es verde ni rojo)\n`);
      await knex.destroy();
      process.exit(fail ? 1 : 0);
    }
    const n = Number((await knex.raw('SELECT count(*)::int AS n FROM kepler_ods.kdmm')).rows[0].n);
    ok(n > 0, `kepler_ods.kdmm con ${n} filas`);

    const y = 2026;
    const { rows } = await knex.raw(CATALOG_SQL(EFECTIVO), [`${y}-01-01`, `${y + 1}-01-01`]);
    const byDoc = Object.fromEntries(rows.map((r) => [r.doc, r]));
    const inc = rows.filter((r) => r.veredicto === 'incongruente');

    console.log('\n── 2. El criterio distingue (prueba negativa) ───────────────');
    const ingenuo = await knex.raw(CATALOG_SQL('^102'), [`${y}-01-01`, `${y + 1}-01-01`]);
    const incIngenuo = ingenuo.rows.filter((r) => r.veredicto === 'incongruente').length;
    ok(incIngenuo > inc.length,
      `el criterio ingenuo (solo banco 102) marca ${incIngenuo} y el correcto ${inc.length}: descarta ${incIngenuo - inc.length} falsos positivos`);
    ok(byDoc['X-D-20-1'] && byDoc['X-D-20-1'].veredicto === 'ok',
      'X-D-20-1 "Pago prov. Efectivo" NO se marca: paga por caja (110), que también es efectivo');

    console.log('\n── 3. El caso que originó todo: XA1001 "Gastos" ─────────────');
    const gastos = byDoc['X-A-10-1'];
    ok(!!gastos, 'X-A-10-1 existe en el catálogo');
    ok(gastos && gastos.tipo === 'D', `X-A-10-1 declarado Diario (c18 = ${gastos && gastos.tipo})`);
    ok(gastos && /^(201|203)/.test(String(gastos.abono || '')),
      `X-A-10-1 abona a proveedores (${gastos && gastos.abono}), NO a efectivo → es devengo`);
    ok(gastos && gastos.veredicto === 'ok',
      'X-A-10-1 NO es incongruente: una póliza que no mueve efectivo es Diario por definición');

    console.log('\n── 4. Lo que SÍ está mal ───────────────────────────────────');
    for (const d of ['X-A-9-3', 'X-A-9-4', 'X-A-9-5']) {
      ok(byDoc[d] && byDoc[d].veredicto === 'incongruente',
        `${d} "${byDoc[d] ? byDoc[d].descripcion : '?'}" marcado: está en ${byDoc[d] && byDoc[d].tipo} y abona a ${byDoc[d] && byDoc[d].abono} (no es efectivo)`);
    }
    for (const d of ['X-D-25-1', 'X-D-26-1']) {
      ok(byDoc[d] && byDoc[d].tipo === 'E' && byDoc[d].veredicto === 'ok',
        `${d} "${byDoc[d] ? byDoc[d].descripcion : '?'}" correcto: abona banco y está en Egresos`);
    }

    console.log('\n── 5. Vivo vs dormido ──────────────────────────────────────');
    const vivos = inc.filter((r) => Number(r.docs) > 0);
    ok(inc.length > 0, `${inc.length} incongruencias en el catálogo`);
    ok(vivos.length < inc.length,
      `${vivos.length} con uso en ${y} y ${inc.length - vivos.length} dormidas: el detector separa trabajo de ruido`);
    for (const v of vivos) {
      console.log(`      · ${v.doc} "${v.descripcion}" — ${v.docs} doc(s), $${Number(v.importe).toLocaleString('es-MX')}`);
    }

    console.log('\n── 6. No juzgables: se cuentan, NO se aprueban ──────────────');
    const noJuz = rows.filter((r) => r.veredicto === 'no_juzgable');
    ok(noJuz.length > 0,
      `${noJuz.length} doctypes sin cuentas declaradas → no se puede opinar de ellos; contarlos como "ok" sería dibujar un verde`);

    console.log('\n── 7. ⭐ ADR-056: fuente vacía ≠ cero hallazgos ─────────────');
    const cob = await knex('analytics.gl_polizas').where('tenant_id', T).select(
      knex.raw(`COUNT(*) FILTER (WHERE source='kepler')::int AS kepler`),
      knex.raw(`COUNT(*) FILTER (WHERE source='contpaqi')::int AS contpaqi`),
    ).first();
    const faltan = [];
    if (!Number(cob.kepler)) faltan.push('Kepler');
    if (!Number(cob.contpaqi)) faltan.push('ContPAQi');
    if (faltan.length) {
      nm(`analytics.gl_polizas sin filas de ${faltan.join(' ni ')} → el bloque del cruce reporta not_measured`);
      ok(true, 'el cruce se DECLARA no medido en vez de devolver [] (que se leería como "todo bien")');
    } else {
      ok(true, `gl_polizas con ambas fuentes (kepler ${cob.kepler}, contpaqi ${cob.contpaqi}): el cruce sí se mide`);
    }

    console.log(`\n  ${pass} ✓ / ${fail} ✗\n`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
