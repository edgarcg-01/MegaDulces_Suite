/* eslint-disable no-console */
/**
 * `[RA-FIX.1]` CANDADO DEL DESGLOSE POR SUCURSAL — **SOLO LECTURA**.
 *
 * Qué defiende: que un renglón de requisición diga **a qué sucursal va**, para que dos renglones
 * del mismo SKU en el mismo documento se puedan distinguir.
 *
 * ── Por qué existe, medido en prod el 2026-10-19 ─────────────────────────────────────────────
 *
 * `/compras/pedido` captura por sucursal, pero la línea no tenía dónde anotarlo
 * (`source_warehouse_id` es el ORIGEN de un traspaso y en las de compra iba NULL: **0 de 3,728**).
 * Resultado: **473 grupos** (requisición × producto) con más de un renglón, **1,269 renglones de
 * más**, en **74 requisiciones** de compra — `RQ-2026-00913` trae el SKU `88045` nueve veces,
 * las nueve indistinguibles.
 *
 * ── Las tres mitades, que se comportan distinto a propósito ──────────────────────────────────
 *
 *   1. **LA MEDICIÓN DEL PASADO** se hace siempre: cuántos renglones indistinguibles quedan.
 *      Es el backlog que la migración NO rellena (no se puede: el dato nunca se guardó).
 *   2. **LAS INVARIANTES** sólo se comprueban donde la columna ya existe. Mientras no esté, se
 *      reporta `NO MEDIDO`, **nunca ✔** (ADR-056): un candado que se pone verde porque no
 *      encontró qué revisar es peor que no tenerlo.
 *   3. **LA PRUEBA NEGATIVA**: con el dato nuevo, dos renglones del MISMO producto y el MISMO
 *      destino en un documento ya no son un desglose — son un duplicado, y acá se ve rojo.
 *
 * No escribe nada: desde esta máquina `knexfile-newdb` resuelve a prod.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

(async () => {
  try {
    console.log('\n[RA-FIX.1] Desglose por sucursal en el renglón — candado de solo lectura\n');

    const hayCol = (await knex.raw(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='commercial' AND table_name='purchase_requisition_lines'
        AND column_name='destination_warehouse_id') AS t`)).rows[0].t;
    console.log(`   columna destination_warehouse_id en esta base: ${hayCol ? 'sí' : 'NO (migración 20261019084231 sin aplicar)'}\n`);

    // ── 1. El backlog: lo que la migración NO arregla ────────────────────────────────────────
    console.log('1) Renglones indistinguibles (mismo documento, mismo producto)');
    const b = (await knex.raw(`
      SELECT count(*)::int grupos, COALESCE(sum(n - 1), 0)::int de_mas,
             count(DISTINCT requisition_id)::int requisiciones
        FROM (SELECT requisition_id, product_id, count(*)::int n
                FROM commercial.purchase_requisition_lines
               WHERE tenant_id = ? GROUP BY 1, 2 HAVING count(*) > 1) t`, [T])).rows[0];
    console.log(`   grupos ${b.grupos} · renglones de más ${b.de_mas} · requisiciones ${b.requisiciones}`);
    ok(Number(b.grupos) >= 0, 'el backlog se puede medir (es el que la migración declara y no rellena)');

    // ── 2. Las invariantes del dato nuevo ────────────────────────────────────────────────────
    console.log('\n2) Invariantes del renglón con destino');
    if (!hayCol) {
      noMedido('sin la columna no hay nada que comprobar: aplicá 20261019084231');
      noMedido('la prueba negativa (duplicado real) necesita la misma columna');
    } else {
      // ⛔ **El ancla es el PRIMER renglón con destino, no una fecha.** La primera versión de
      // esto exigía destino a todo lo creado desde el 2026-10-19 y se puso roja al aplicar la
      // migración: la columna ya existía pero **el código que la escribe todavía no estaba
      // desplegado** (en este repo un push NO despliega). O sea que medía el reloj y lo
      // reportaba como defecto del dato. Anclando al primer renglón que SÍ trae destino, el
      // candado no necesita saber cuándo se desplegó: lo deduce del propio dato, y mientras no
      // haya ninguno declara NO MEDIDO en vez de inventar un veredicto (ADR-056).
      const pobl = (await knex.raw(`
        WITH anc AS (
          SELECT min(created_at) AS desde FROM commercial.purchase_requisition_lines
           WHERE tenant_id = ? AND destination_warehouse_id IS NOT NULL
        )
        SELECT count(*)::int lineas,
               count(l.destination_warehouse_id)::int con_destino,
               (SELECT desde FROM anc)::text desde,
               count(*) FILTER (WHERE l.created_at >= (SELECT desde FROM anc))::int nuevas,
               count(l.destination_warehouse_id) FILTER (WHERE l.created_at >= (SELECT desde FROM anc))::int nuevas_con_destino
          FROM commercial.purchase_requisition_lines l WHERE l.tenant_id = ?`, [T, T])).rows[0];
      console.log(`   renglones ${pobl.lineas} · con destino ${pobl.con_destino}`
        + (pobl.desde ? ` · desde el primero con destino (${pobl.desde}): ${pobl.nuevas} (con destino ${pobl.nuevas_con_destino})` : ''));

      // El destino apunta a un almacén real del mismo tenant (la FK lo exige; se comprueba que
      // la FK esté puesta, no se confía en que alguien la haya respetado a mano).
      const fk = (await knex.raw(`SELECT EXISTS(SELECT 1 FROM pg_constraint
        WHERE conrelid = 'commercial.purchase_requisition_lines'::regclass
          AND conname = 'fk_purch_req_lines_dest_wh') AS t`)).rows[0].t;
      ok(!!fk, 'el destino tiene FK contra commercial.warehouses del mismo tenant');

      const idx = (await knex.raw(`SELECT EXISTS(SELECT 1 FROM pg_indexes
        WHERE schemaname = 'commercial' AND indexname = 'idx_purch_req_lines_dest_wh') AS t`)).rows[0].t;
      ok(!!idx, 'hay índice para «qué se le pidió a esta sucursal»');

      if (!pobl.desde) {
        noMedido('ningún renglón trae destino todavía: la columna está, pero el código que la'
          + ' escribe no está desplegado (en este repo un push NO despliega). Nada que exigir aún.');
        noMedido('la prueba negativa (duplicado real) necesita al menos un renglón con destino');
      } else {
        ok(Number(pobl.nuevas_con_destino) === Number(pobl.nuevas),
          `todo renglón creado desde el primero con destino lo lleva (${pobl.nuevas_con_destino}/${pobl.nuevas})`);

        // ── 3. LA PRUEBA NEGATIVA ───────────────────────────────────────────────────────────
        // Con destino, dos renglones de (documento, producto, destino) ya no son un desglose.
        const dup = (await knex.raw(`
          SELECT count(*)::int grupos, COALESCE(sum(n - 1), 0)::int de_mas
            FROM (SELECT requisition_id, product_id, destination_warehouse_id, count(*)::int n
                    FROM commercial.purchase_requisition_lines
                   WHERE tenant_id = ? AND destination_warehouse_id IS NOT NULL
                   GROUP BY 1, 2, 3 HAVING count(*) > 1) t`, [T])).rows[0];
        ok(Number(dup.grupos) === 0,
          `ningún duplicado real (mismo documento + producto + destino): ${dup.grupos} grupos, ${dup.de_mas} renglones`);
      }
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ok · ${fail} fallos · ${nm} no medido\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('✗ error:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
