/* eslint-disable no-console */
/**
 * GX.9 — El ALCANCE DE CUENTAS de /finanzas/egresos: la pantalla publicaba sólo
 * compras (511) y gastos (6xx). Faltaban el ACTIVO NO CIRCULANTE (150) y los
 * GASTOS FINANCIEROS E IMPUESTOS (702-764) — dinero que sale y que el desempeño
 * de egresos no contaba.
 *
 * Esta prueba mide el ANTES/DESPUÉS del cambio simulando el pipeline del importer
 * `import-expenses-polizas.js` (WHERE + Fix#B traspasos + Fix#1 factura-vs-
 * presupuesto) sobre `kepler_ods.kdc2YYMM`, que es el mismo dato que el importer
 * lee de `md.kdc2YYMM` en cada sucursal. No escribe nada.
 *
 * Candados:
 *   1-2. Las familias que YA se publicaban (5 compras, 6 gastos) no se mueven ni
 *        un centavo — el cambio SUMA, no reinterpreta.
 *   3-4. Las familias nuevas entran COMPLETAS (crudo == publicado).
 *   5.   701 PRODUCTOS FINANCIEROS (que es INGRESO) NO se cuela: por eso el rango
 *        arranca en 702 y no en 700.
 *   6.   PRUEBA NEGATIVA (ADR-056: un gate sin prueba negativa es una intención):
 *        sin acotar Fix#1 a 511/6xx, ese fix DESTRUYE parte de las cuentas nuevas.
 *        Si algún día alguien le quita el acote, este candado se pone rojo.
 *   7.   La ventana tiene datos: si el ODS llega vacío se DECLARA `NO MEDIDO`, no
 *        se aprueba en verde por vacuidad.
 *
 * Verificado 2026-09-11 contra prod. La ventana son las últimas 12 tablas `kdc2`
 * que el ODS tenga, así que los totales absolutos se mueven con la ventana; lo que
 * NO se mueve —y es lo que esta prueba fija— es la igualdad antes/después de las
 * familias 5 y 6. Corrida de referencia:
 *   compras $464,180,151.26 / 10,158 movs · gastos $55,291,664.68 / 18,988 movs
 *   (idénticos antes y después) + activo $4,658,284.40 (242 movs)
 *   + financieros $6,053,276.95 (447 movs) = +$10,711,561.35 (+2.06%).
 *   Sin el acote de Fix#1 se perderían $427,666.83 en 28 movimientos.
 * Sobre los 12 meses cerrados 2025-09…2026-08 el alta fue +$10,879,931.40 (+1.53%).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const money = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Predicados espejo de import-expenses-polizas.js. Si allá cambian, acá también.
const WHERE_VIEJO = "ca='C' AND importe<>0 AND (cuenta='511' OR cuenta LIKE '6%')";
const WHERE_NUEVO = "ca='C' AND importe<>0 AND (cuenta='511' OR cuenta LIKE '6%' OR mayor='150' OR mayor BETWEEN '702' AND '764')";
const FIXB = "NOT (sucursal<>'00' AND mayor='511' AND (upper(beneficiario) LIKE 'SUCURSAL%' OR upper(beneficiario) LIKE '%CEDIS%'"
  + " OR upper(beneficiario) LIKE '%CENTRO DE DIST%' OR upper(beneficiario) LIKE '%TRASPASO%'))";
const FIX1_SCOPE = "(s.mayor='511' OR s.mayor LIKE '6%')";

(async () => {
  try {
    // Ventana: los últimos 12 meses de kdc2 que existan en el ODS (month-agnostic).
    const tabs = (await knex.raw(
      "SELECT table_name FROM information_schema.tables"
      + " WHERE table_schema='kepler_ods' AND table_name ~ '^kdc2[0-9]{4}$' ORDER BY 1 DESC LIMIT 12",
    )).rows.map((r) => r.table_name);
    ok(tabs.length > 0, `kepler_ods tiene tablas de póliza kdc2 (${tabs.length} en la ventana)`);
    if (!tabs.length) {
      console.log('\nGX.9 alcance de cuentas: NO MEDIDO — sin kepler_ods.kdc2* en este entorno');
      await knex.destroy();
      process.exit(1);
    }

    const RAW = tabs.map((t) => `SELECT sucursal, c2::date fecha, btrim(c3::text) cuenta, left(btrim(c3::text),1) familia,
      split_part(btrim(c3::text),'-',1) mayor, c4 ca, coalesce(c5,0)::numeric importe,
      btrim(coalesce(c6,'')) beneficiario, btrim(coalesce(c19,'')) folio FROM kepler_ods.${t}`).join(' UNION ALL ');

    // Fix#1 = borra la capa no-operativa (factura real vs presupuesto). `scope` acota
    // a qué mayores aplica: 'TRUE' reproduce el fix SIN acotar (el bug).
    const pipeline = (where, scope) => `
      WITH s AS (SELECT * FROM (${RAW}) r WHERE ${where} AND ${FIXB}),
      capas AS (
        SELECT sucursal, mayor, to_char(fecha,'YYYY-MM') mes,
               coalesce(sum(importe) FILTER (WHERE folio<>''),0) det,
               coalesce(sum(importe) FILTER (WHERE folio=''),0) res
          FROM s GROUP BY 1,2,3
         HAVING coalesce(sum(importe) FILTER (WHERE folio<>''),0)>0 AND coalesce(sum(importe) FILTER (WHERE folio=''),0)>0)
      SELECT s.* FROM s LEFT JOIN capas c
        ON c.sucursal=s.sucursal AND c.mayor=s.mayor AND c.mes=to_char(s.fecha,'YYYY-MM')
       WHERE c.sucursal IS NULL
          OR NOT ( ${scope} AND ((c.det >= 0.5*c.res AND s.folio='') OR (c.det < 0.5*c.res AND s.folio<>'')) )`;
    const VIEJO = pipeline(WHERE_VIEJO, 'TRUE');
    const NUEVO = pipeline(WHERE_NUEVO, FIX1_SCOPE);

    const byFam = async (sql) => (await knex.raw(
      `SELECT familia, count(*)::int movs, round(sum(importe),2)::numeric total FROM (${sql}) x GROUP BY 1`)).rows;
    const viejo = new Map((await byFam(VIEJO)).map((r) => [r.familia, r]));
    const nuevo = new Map((await byFam(NUEVO)).map((r) => [r.familia, r]));

    // 1-2. Lo que ya se publicaba no se mueve.
    for (const f of ['5', '6']) {
      const a = viejo.get(f); const b = nuevo.get(f);
      ok(a && b && Number(a.total) === Number(b.total) && a.movs === b.movs,
        `familia ${f} intacta: ${a ? money(a.total) : '—'} / ${a ? a.movs : 0} movs sin cambio`);
    }

    // 3-4. Lo nuevo entra completo: Fix#1 ya no lo toca.
    const crudo = (await knex.raw(
      `SELECT familia, count(*)::int movs, round(sum(importe),2)::numeric total FROM (${RAW}) r
        WHERE ca='C' AND importe<>0 AND (mayor='150' OR mayor BETWEEN '702' AND '764') GROUP BY 1`)).rows;
    ok(crudo.length > 0, `la ventana tiene cargos a 150 / 702-764 que medir (${crudo.length} familia/s)`);
    for (const c of crudo) {
      const n = nuevo.get(c.familia);
      ok(n && Number(n.total) === Number(c.total) && n.movs === c.movs,
        `familia ${c.familia} entra completa (crudo == publicado): ${money(c.total)} / ${c.movs} movs`);
    }

    // 5. 701 PRODUCTOS FINANCIEROS es INGRESO: fuera del egreso.
    const p701 = (await knex.raw(
      `SELECT coalesce(round(sum(importe),2),0)::numeric t FROM (${NUEVO}) x WHERE mayor='701'`)).rows[0].t;
    ok(Number(p701) === 0, `701 PRODUCTOS FINANCIEROS (ingreso) queda fuera del egreso: ${money(p701)}`);

    // 6. PRUEBA NEGATIVA: sin el acote, Fix#1 destruye parte de las cuentas nuevas.
    const perdido = (await knex.raw(
      `SELECT round(coalesce(sum(importe),0),2)::numeric t, count(*)::int n FROM (${NUEVO}) a
        WHERE (a.mayor='150' OR a.mayor BETWEEN '702' AND '764')
          AND NOT EXISTS (SELECT 1 FROM (${pipeline(WHERE_NUEVO, 'TRUE')}) b
            WHERE b.sucursal=a.sucursal AND b.fecha=a.fecha AND b.cuenta=a.cuenta
              AND b.importe=a.importe AND b.folio=a.folio AND b.beneficiario=a.beneficiario)`)).rows[0];
    ok(Number(perdido.t) > 0,
      `prueba negativa: sin acotar Fix#1 a 511/6xx se perderían ${money(perdido.t)} (${perdido.n} movs) de las cuentas nuevas`);

    const tv = [...viejo.values()].reduce((a, r) => a + Number(r.total), 0);
    const tn = [...nuevo.values()].reduce((a, r) => a + Number(r.total), 0);
    console.log(`  · egreso total de la ventana: ${money(tv)} → ${money(tn)} (+${money(tn - tv)} · +${((tn / tv - 1) * 100).toFixed(2)}%)`);

    console.log(`\nGX.9 alcance de cuentas de egresos: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
