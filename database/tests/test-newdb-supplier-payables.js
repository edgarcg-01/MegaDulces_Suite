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

    // ── [TES.3] El saldo inicial de bancos no se deja secuestrar por una fecha imposible ──
    console.log('\n[TES.3] saldo inicial de bancos — ventana de fecha posible');
    const b = (await knex.raw(`
      WITH crudo AS (
        SELECT max(movement_date) AS as_of,
               (SELECT coalesce(sum(running_balance),0) FROM (
                  SELECT DISTINCT ON (bank_account_id) running_balance FROM finance.bank_movements
                   WHERE tenant_id = ? AND deleted_at IS NULL
                   ORDER BY bank_account_id, movement_date DESC, created_at DESC) x) AS saldo
          FROM finance.bank_movements WHERE tenant_id = ? AND deleted_at IS NULL
      ), sano AS (
        SELECT max(movement_date) AS as_of,
               (SELECT coalesce(sum(running_balance),0) FROM (
                  SELECT DISTINCT ON (bank_account_id) running_balance FROM finance.bank_movements
                   WHERE tenant_id = ? AND deleted_at IS NULL
                     AND movement_date BETWEEN '2015-01-01' AND current_date
                   ORDER BY bank_account_id, movement_date DESC, created_at DESC) y) AS saldo
          FROM finance.bank_movements
         WHERE tenant_id = ? AND deleted_at IS NULL
           AND movement_date BETWEEN '2015-01-01' AND current_date
      ), anom AS (
        SELECT count(*) AS n, count(*) FILTER (WHERE movement_date > current_date) AS futuras,
               count(*) FILTER (WHERE movement_date < '2015-01-01') AS absurdas
          FROM finance.bank_movements WHERE tenant_id = ? AND deleted_at IS NULL
           AND movement_date NOT BETWEEN '2015-01-01' AND current_date
      )
      SELECT c.as_of AS as_of_crudo, round(c.saldo,2) AS saldo_crudo,
             s.as_of AS as_of_sano,  round(s.saldo,2) AS saldo_sano,
             a.n AS anomalas, a.futuras, a.absurdas
        FROM crudo c, sano s, anom a`, [T, T, T, T, T])).rows[0];

    if (b.as_of_sano == null) {
      noMedido('sin movimientos bancarios con fecha posible: el saneo del saldo queda sin evaluar.');
    } else {
      ok(new Date(b.as_of_sano) <= new Date(), 'el as_of de bancos NO queda en el futuro');
      // PRUEBA NEGATIVA: si la ventana no cambia nada, la guarda no esta haciendo nada y
      // tampoco se puede afirmar que proteja. Se DECLARA, no se pone verde.
      if (Number(b.anomalas) > 0) {
        const aire = Math.round((Number(b.saldo_crudo) - Number(b.saldo_sano)) * 100) / 100;
        ok(true, `la guarda es portante: ${b.anomalas} filas de fecha imposible (${b.futuras} futuras, ${b.absurdas} absurdas)`);
        ok(new Date(b.as_of_crudo) > new Date(b.as_of_sano) || aire !== 0,
          `y mueve algo publicado: as_of ${String(b.as_of_crudo).slice(0, 10)} -> ${String(b.as_of_sano).slice(0, 10)}, saldo ${money(aire)} de aire`);
      } else {
        noMedido('no hay filas de fecha imposible en este destino: la guarda del saldo queda sin ejercitar (en prod son 23 filas y $517,137.63 de aire).');
      }
    }

    // ── [TES.10] El ejercicio de PRUEBA no puede duplicar las obligaciones ───────────────
    console.log('\n[TES.10] obligaciones — el duplicado de prueba queda fuera');
    const o = (await knex.raw(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM budget.budget_lines bl JOIN budget.budgets bb ON bb.id = bl.budget_id
                WHERE bl.id = o.budget_line_id AND bb.is_test = true)) AS de_prueba,
             count(*) FILTER (WHERE budget_line_id IS NULL) AS sin_partida
        FROM budget.expense_obligations o WHERE tenant_id = ?`, [T])).rows[0];
    if (Number(o.total) === 0) {
      noMedido('sin obligaciones de gasto en este destino: el filtro del duplicado queda sin ejercitar.');
    } else if (Number(o.de_prueba) > 0) {
      ok(true, `el duplicado existe y es separable: ${o.de_prueba} de ${o.total} obligaciones cuelgan de un ejercicio is_test`);
      // ⚠️ Lo que NO se puede afirmar hoy: que el filtro proteja dinero publicado. Las 312 estan
      // en 'propuesta' y el motor ya las excluye por estado. Es una bomba ARMADA, no desactivada.
      noMedido("el filtro de is_test aun no mueve dinero publicado: las obligaciones siguen en 'propuesta' y salen por estado. Muerde el dia que se autorice la primera.");
    } else {
      noMedido('no hay obligaciones colgando de un ejercicio is_test aqui: el filtro queda sin ejercitar (en prod son 156 de 312, $74,809,091.57).');
    }
    // NOT EXISTS y JOIN solo difieren cuando hay obligaciones sin partida. Si no las hay, la
    // eleccion no se puede justificar con datos, y se dice asi en vez de darla por buena.
    if (Number(o.sin_partida) === 0) {
      noMedido('no hay obligaciones sin partida: NOT EXISTS y JOIN dan lo mismo aqui, la eleccion no esta ejercitada.');
    } else {
      ok(true, `${o.sin_partida} obligaciones sin partida: NOT EXISTS las conserva, un JOIN las perderia`);
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
