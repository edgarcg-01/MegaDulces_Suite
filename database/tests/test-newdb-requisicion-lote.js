/* eslint-disable no-console */
/**
 * `[RQ.10]` CANDADO DEL LOTE DE REQUISICIONES — **SOLO LECTURA**.
 *
 * Qué defiende, en dos mitades que se comportan distinto a propósito:
 *
 *   1. **LA MEDICIÓN QUE JUSTIFICA LA FASE** — cuántos documentos sale de un solo «Armar». Se
 *      mide siempre, porque se puede medir siempre: reconstruyendo las ráfagas por tiempo. Si el
 *      reparto cambiara y un «Armar» pasara a producir UN documento, esta fase dejaría de tener
 *      sentido y acá se vería.
 *      ⚠️ Esa reconstrucción es **una inferencia, no un hecho**, y por eso es exactamente lo que
 *      `[RQ.8]` vino a reemplazar con una columna. Se usa para medir el PASADO, nunca para
 *      publicar lotes en pantalla.
 *
 *   2. **LAS INVARIANTES DEL LOTE REAL** — que la liga bajada→compra apunte a una COMPRA, del
 *      MISMO lote y del MISMO tenant. Esto sólo se puede comprobar donde la migración ya corrió:
 *      **mientras no esté, se reporta `NO MEDIDO`, no ✔** (ADR-056). Un candado que se pone verde
 *      porque no encontró nada que revisar es peor que no tenerlo.
 *
 * No escribe nada: desde esta máquina `knexfile-newdb` resuelve a prod. Por eso tampoco llama a
 * `assertSafeTarget`, que es la guarda de los tests que escriben.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

(async () => {
  try {
    console.log('\n[RQ.10] Lote de requisiciones — candado de solo lectura\n');

    const cols = (await knex.raw(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='commercial' AND table_name='purchase_requisitions'
        AND column_name IN ('batch_id','batch_folio','origin_requisition_id')`)).rows.map((r) => r.column_name);
    const hayLote = cols.length === 3;
    console.log(`   columnas del lote en esta base: ${hayLote ? 'las 3' : cols.join(', ') || 'ninguna'}\n`);

    // ── 1. El fan-out: por qué existe esta fase ──────────────────────────────────────────────
    console.log('1) Cuántos documentos sale de un solo «Armar» (ráfagas reconstruidas por tiempo)');
    const f = (await knex.raw(`
      WITH r AS (
        SELECT created_by, created_at, source_type, warehouse_id, supplier_id,
               created_at - LAG(created_at) OVER (PARTITION BY created_by ORDER BY created_at) AS gap
          FROM commercial.purchase_requisitions WHERE tenant_id = ?
      ), m AS (SELECT *, CASE WHEN gap IS NULL OR gap > interval '90 seconds' THEN 1 ELSE 0 END AS nuevo FROM r
      ), l AS (SELECT *, SUM(nuevo) OVER (PARTITION BY created_by ORDER BY created_at ROWS UNBOUNDED PRECEDING) AS lote FROM m
      ), g AS (
        SELECT created_by, lote, count(*)::int n,
               count(DISTINCT warehouse_id)::int alm,
               count(DISTINCT supplier_id) FILTER (WHERE supplier_id IS NOT NULL)::int prov
          FROM l GROUP BY 1,2
      )
      SELECT count(*)::int lotes, round(avg(n),1)::text prom, max(n)::int peor,
             count(*) FILTER (WHERE n >= 10)::int diez_o_mas,
             count(*) FILTER (WHERE alm > prov)::int infla_sucursal,
             count(*) FILTER (WHERE prov > alm)::int infla_proveedor
        FROM g`, [T])).rows[0];
    if (!Number(f.lotes)) {
      noMedido('no hay requisiciones: el fan-out no se pudo medir');
    } else {
      console.log(`     ${f.lotes} ráfagas · promedio ${f.prom} · peor ${f.peor} · ${f.diez_o_mas} de 10 o más`);
      console.log(`     la infla la sucursal en ${f.infla_sucursal} · el proveedor en ${f.infla_proveedor}`);
      ok(Number(f.peor) > 1, `un «Armar» produce MÁS DE UN documento (peor caso: ${f.peor}) — es lo que hace falta atar`);
      ok(Number(f.diez_o_mas) > 0, `hay ${f.diez_o_mas} ráfaga(s) de 10 o más documentos: la lista plana no alcanza`);
    }

    // ── 2. Las invariantes del lote real ─────────────────────────────────────────────────────
    console.log('\n2) Invariantes del lote (sólo donde la migración ya corrió)');
    if (!hayLote) {
      noMedido('faltan las columnas del lote (migración 20261006190000): no se pudo comprobar NI UNA invariante');
      noMedido('la liga bajada→compra no se pudo verificar: no existe la columna origin_requisition_id');
    } else {
      const inv = (await knex.raw(`
        SELECT
          count(*) FILTER (WHERE r.batch_id IS NOT NULL)::int                                   AS con_lote,
          count(*) FILTER (WHERE r.batch_id IS NOT NULL AND r.batch_folio IS NULL)::int          AS lote_sin_folio,
          count(*) FILTER (WHERE r.origin_requisition_id IS NOT NULL)::int                       AS ligadas,
          count(*) FILTER (WHERE r.origin_requisition_id IS NOT NULL AND r.source_type <> 'branch')::int AS liga_desde_compra,
          count(*) FILTER (WHERE r.origin_requisition_id IS NOT NULL AND o.id IS NULL)::int       AS liga_rota,
          count(*) FILTER (WHERE r.origin_requisition_id IS NOT NULL AND o.source_type <> 'supplier')::int AS liga_a_traspaso,
          count(*) FILTER (WHERE r.origin_requisition_id IS NOT NULL AND o.batch_id IS DISTINCT FROM r.batch_id)::int AS liga_otro_lote
          FROM commercial.purchase_requisitions r
          LEFT JOIN commercial.purchase_requisitions o
            ON o.tenant_id = r.tenant_id AND o.id = r.origin_requisition_id
         WHERE r.tenant_id = ?`, [T])).rows[0];
      console.log(`     ${inv.con_lote} con lote · ${inv.ligadas} bajadas ligadas a su compra`);
      if (!Number(inv.con_lote)) {
        noMedido('la migración está pero todavía no se generó ningún lote: las invariantes no se pudieron ejercer');
      } else {
        ok(Number(inv.lote_sin_folio) === 0, 'toda requisición con lote tiene su folio de lote');
        ok(Number(inv.liga_desde_compra) === 0, 'sólo una BAJADA (branch) apunta a un origen — una compra nunca lo hace');
      }
      if (!Number(inv.ligadas)) {
        noMedido('no hay ninguna bajada ligada todavía: la FK no se pudo ejercer en ningún sentido');
      } else {
        ok(Number(inv.liga_rota) === 0, 'ninguna liga apunta a una requisición que no existe');
        ok(Number(inv.liga_a_traspaso) === 0, 'PRUEBA NEGATIVA: ninguna bajada apunta a otro TRASPASO — el origen es siempre una compra');
        ok(Number(inv.liga_otro_lote) === 0, 'PRUEBA NEGATIVA: ninguna bajada apunta a una compra de OTRO lote');
      }
    }

    // ── 3. El texto libre que la FK viene a reemplazar ───────────────────────────────────────
    console.log('\n3) Cuánto hay todavía atado sólo por texto libre');
    const t = (await knex.raw(`
      SELECT count(*) FILTER (WHERE notes ILIKE 'Bajada de compra consolidada%')::int bajadas_texto,
             round(COALESCE(sum(total_cost) FILTER (WHERE notes ILIKE 'Bajada de compra consolidada%'),0)::numeric,0)::text monto,
             count(*) FILTER (WHERE source_type='supplier' AND notes ILIKE '%consolidado%')::int compras_consolidadas
        FROM commercial.purchase_requisitions WHERE tenant_id = ?`, [T])).rows[0];
    console.log(`     ${t.bajadas_texto} bajadas por $${t.monto} y ${t.compras_consolidadas} compras consolidadas, atadas sólo por notes`);
    ok(true, `medido y declarado: ${t.bajadas_texto} bajadas que la FK va a poder rastrear (las creadas antes quedan con el texto)`);

    console.log(`\n[RQ.10] lote: ${pass} OK, ${fail} fallidos, ${nm} no medidos`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
