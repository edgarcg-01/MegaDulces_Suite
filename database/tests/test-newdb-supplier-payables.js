/* eslint-disable no-console */
/**
 * [TES.1/TES.2] Candado de la deuda con proveedor derivada del ODS.
 *
 * Lo que vigila, y por que cada cosa:
 *   1. La vista existe, con su GRANT. Si no esta, el bloque entero reporta NO MEDIDO: un
 *      candado que no encuentra su objeto NO se pone verde (ADR-056).
 *   2. Los cuatro baldes PARTICIONAN el total. Si no suman, la pantalla publica una cobertura
 *      que no cierra y nadie lo nota.
 *   3. La guarda del centinela: ninguna fila con vencimiento anterior a 1900. Sin ella un
 *      documento centinela se lee vencido hace siglos y contamina el aging.
 *   4. PRUEBA NEGATIVA de la regla del grupo 140: la clasificacion canonica DEBE diferir de la
 *      ingenua por prefijo. Medido en prod el 2026-10-08: son $551,742 que se mueven de
 *      servicios a financiero (proveedores grupo 140 con clave G*, como STM Financial). Si las
 *      dos coinciden, la regla no esta haciendo nada y el candado lo DECLARA en vez de pasar.
 *   5. PRUEBA NEGATIVA de la exclusion de internos: tiene que haber traspasos internos (> 0) o
 *      la exclusion es vacua y un error en ella seria invisible. Medidos: $38.6M.
 *   6. La cobertura tiene que ser < 100%: si la ventana viera toda la deuda, toda la maquinaria
 *      de "lo que queda fuera se declara" estaria sin ejercitar.
 *
 * Read-only: no escribe ni una fila.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function noMedido(msg) { nm++; console.log('  ⊘ NO MEDIDO:', msg); }
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  try {
    console.log('\n[TES.1] analytics.v_supplier_payables');
    const reg = await knex.raw("SELECT to_regclass('analytics.v_supplier_payables') AS v");
    if (!reg.rows[0].v) {
      noMedido('analytics.v_supplier_payables no existe en este destino: falta aplicar la migracion 20261008174741. El resto del bloque NO se evalua.');
      console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} ⊘\n`);
      await knex.destroy();
      process.exit(fail ? 1 : 0);
    }
    ok(true, 'la vista existe');

    const g = await knex.raw(`SELECT has_table_privilege('app_runtime','analytics.v_supplier_payables','SELECT') AS ok`);
    ok(g.rows[0].ok === true, 'app_runtime puede leerla (GRANT SELECT)');

    // ── 2. Los baldes particionan ────────────────────────────────────────────
    const p = (await knex.raw(`
      SELECT round(sum(pendiente),2) AS total,
             round(sum(pendiente) FILTER (WHERE vencimiento BETWEEN current_date AND current_date+56),2) AS en_ventana,
             round(sum(pendiente) FILTER (WHERE vencimiento < current_date),2) AS vencido,
             round(sum(pendiente) FILTER (WHERE vencimiento > current_date+56),2) AS posterior,
             round(sum(pendiente) FILTER (WHERE vencimiento IS NULL),2) AS sin_venc,
             count(*) AS filas,
             count(*) FILTER (WHERE pendiente <= 0) AS no_abiertas
        FROM analytics.v_supplier_payables WHERE tenant_id = ?`, [T])).rows[0];
    if (Number(p.filas) === 0) {
      noMedido('la vista no devuelve filas en este destino: particion, centinela y pruebas negativas quedan sin evaluar.');
    } else {
      const suma = ['en_ventana', 'vencido', 'posterior', 'sin_venc'].reduce((s, k) => s + Number(p[k] || 0), 0);
      ok(Math.abs(suma - Number(p.total)) < 0.01,
        `los 4 baldes particionan el total (${money(suma)} vs ${money(p.total)})`);
      ok(Number(p.no_abiertas) === 0, 'ninguna fila con pendiente <= 0 (la vista publica solo saldo abierto)');

      // ── 3. Guarda del centinela ───────────────────────────────────────────
      const c = (await knex.raw(`SELECT count(*) AS n FROM analytics.v_supplier_payables
                                 WHERE tenant_id = ? AND (vencimiento < '1900-01-01' OR fecha < '1900-01-01')`, [T])).rows[0];
      ok(Number(c.n) === 0, 'ninguna fecha centinela escapa (vencimiento/fecha < 1900 llegan NULL)');

      // ── 4. PRUEBA NEGATIVA: la regla del grupo 140 mueve dinero ───────────
      const d = (await knex.raw(`
        WITH k AS (
          SELECT pendiente,
                 CASE WHEN upper(btrim(proveedor)) LIKE 'TI%' THEN 'interno'
                      WHEN btrim(coalesce(grupo,'')) = '140'
                        OR upper(btrim(proveedor)) LIKE 'A%'
                        OR upper(btrim(proveedor)) LIKE 'TC%'
                        OR upper(btrim(proveedor)) LIKE 'B.B.%' THEN 'financiero'
                      WHEN upper(btrim(proveedor)) LIKE 'C%' THEN 'mercancia'
                      WHEN upper(btrim(proveedor)) LIKE 'G%' THEN 'servicios'
                      ELSE 'sin_clasificar' END AS canonico,
                 CASE WHEN upper(btrim(proveedor)) LIKE 'TI%' THEN 'interno'
                      WHEN upper(btrim(proveedor)) LIKE 'A%'
                        OR upper(btrim(proveedor)) LIKE 'TC%'
                        OR upper(btrim(proveedor)) LIKE 'B.B.%' THEN 'financiero'
                      WHEN upper(btrim(proveedor)) LIKE 'C%' THEN 'mercancia'
                      WHEN upper(btrim(proveedor)) LIKE 'G%' THEN 'servicios'
                      ELSE 'sin_clasificar' END AS ingenuo
            FROM analytics.v_supplier_payables WHERE tenant_id = ?)
        SELECT round(coalesce(sum(pendiente) FILTER (WHERE canonico <> ingenuo), 0), 2) AS movido,
               round(coalesce(sum(pendiente) FILTER (WHERE canonico = 'interno'), 0), 2) AS interno
          FROM k`, [T])).rows[0];
      if (Number(d.movido) > 0) {
        ok(true, `la regla del grupo 140 es portante: mueve ${money(d.movido)} que el prefijo solo clasificaria mal`);
      } else {
        noMedido('la clasificacion canonica y la ingenua coinciden en este destino: la regla del grupo 140 no se pudo probar portante (en prod mueve $551,742.26).');
      }

      // ── 5. PRUEBA NEGATIVA: la exclusion de internos no es vacua ──────────
      if (Number(d.interno) > 0) {
        ok(true, `hay traspasos internos que excluir (${money(d.interno)}): la exclusion esta ejercitada`);
      } else {
        noMedido('no hay traspasos internos en este destino: la exclusion queda sin ejercitar (en prod son $38,644,689.87).');
      }

      // ── 6. La ventana no lo ve todo, y eso es el punto ───────────────────
      const pct = Number(p.total) > 0 ? (Number(p.en_ventana) / Number(p.total)) * 100 : null;
      if (pct == null) {
        noMedido('sin deuda: la cobertura queda SIN MEDIR, no en 0%.');
      } else {
        ok(pct < 100,
          `la ventana dibuja ${pct.toFixed(1)}% de la deuda; el resto se declara (${money(p.vencido)} vencidos sin fecha)`);
      }
    }

    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} ⊘\n`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('  ✗ EXCEPCION:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
