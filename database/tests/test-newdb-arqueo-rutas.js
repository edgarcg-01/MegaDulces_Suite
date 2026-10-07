/* eslint-disable no-console */
/**
 * SM.36 — Smoke del arqueo de rutas (RD/RV).
 *
 * Tres bloques:
 *   1. Schema — el CHECK admite rd/rv, la clave unica incluye la ruta, y el
 *      CHECK de coherencia ata `route_code` a esos dos tipos.
 *   2. Las compuertas, con PRUEBA NEGATIVA y su control positivo: un candado
 *      que rechaza TODO se ve igual de verde que uno que discrimina.
 *   3. El catalogo de rutas por sucursal — el alcance que hace utilizable la
 *      pantalla, y lo que resuelve solo la ambiguedad de `501`/`502`.
 *
 * ⚠️ Los bloques que dependen de datos de catalogo reportan **NO MEDIDO** si la
 * DB no los tiene, y NO se pintan verdes: un bloque sin datos con que
 * comprobarse miente si dice ✓ (ADR-056).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const WH_TEST = 'ZZ-SM36';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };

(async () => {
  try {
    console.log('\n[1] Schema');
    const ck = (await knex.raw(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid='reconciliation.blind_counts'::regclass AND conname='blind_counts_tipo_check'`)).rows[0];
    ok(!!ck && /'rd'/.test(ck.d) && /'rv'/.test(ck.d), 'el CHECK de tipo admite rd y rv');

    const cols = (await knex.raw(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='reconciliation' AND table_name='blind_counts' AND column_name='route_code'`)).rows;
    ok(cols.length === 1, 'existe la columna route_code');

    const ix = (await knex.raw(`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='reconciliation' AND tablename='blind_counts' AND indexname LIKE 'uq_blind_count%'`)).rows;
    ok(ix.length === 1, `una sola clave unica en blind_counts (${ix.map((r) => r.indexname).join(', ')})`);
    ok(ix.length === 1 && /route_code/.test(ix[0].indexdef),
      'la clave unica incluye route_code — sin esto una tienda solo podria arquear UNA ruta por dia');

    console.log('\n[2] Las compuertas (prueba negativa + control positivo)');
    await knex.transaction(async (trx) => {
      const ins = (tipo, ruta, caja) => trx.raw(
        `INSERT INTO reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, route_code, denominations, total_contado)
         VALUES (?, ?, ?, '2026-01-02', 'SM36', ?, ?, '{}'::jsonb, 100)`,
        [T, WH_TEST, caja, tipo, ruta]);

      // NEGATIVA: un arqueo de ruta SIN ruta no puede entrar. Sin este CHECK,
      // dos rd sin codigo colisionarian entre si por el COALESCE de la clave.
      let rechazoSinRuta = false;
      try { await ins('rd', null, 'RD'); } catch (e) { rechazoSinRuta = /route_code_check/.test(e.message); }
      ok(rechazoSinRuta, 'NEGATIVA: rd sin route_code es RECHAZADO');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    await knex.transaction(async (trx) => {
      const ins = (tipo, ruta, caja) => trx.raw(
        `INSERT INTO reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, route_code, denominations, total_contado)
         VALUES (?, ?, ?, '2026-01-02', 'SM36', ?, ?, '{}'::jsonb, 100)`,
        [T, WH_TEST, caja, tipo, ruta]);

      // CONTROL POSITIVO del candado de arriba: con ruta SI entra.
      await ins('rd', '21', 'RD');
      ok(true, 'CONTROL POSITIVO: rd CON route_code entra');

      // Dos rutas distintas el mismo dia en la misma tienda: es el caso real de
      // Padre Hidalgo, que tiene 7 rutas RD. Con la clave vieja era imposible.
      await ins('rd', '22', 'RD');
      const n = (await trx.raw(
        `SELECT count(*)::int n FROM reconciliation.blind_counts WHERE warehouse_code = ?`, [WH_TEST])).rows[0].n;
      ok(n === 2, `dos rutas distintas el mismo dia conviven: ${n} filas (con la clave vieja habria sido 1)`);

      // NEGATIVA: la MISMA ruta dos veces el mismo dia, no.
      let rechazoDup = false;
      try { await ins('rd', '22', 'RD'); } catch (e) { rechazoDup = /unique|duplicad/i.test(e.message); }
      ok(rechazoDup, 'NEGATIVA: la misma ruta dos veces el mismo dia es RECHAZADA');
      throw new Error('__rb__');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    await knex.transaction(async (trx) => {
      // NEGATIVA a la inversa: un arqueo de CAJA no puede traer ruta. Sin esto,
      // `route_code` seria un campo suelto que cualquiera llena y nadie lee.
      let rechazoCajaConRuta = false;
      try {
        await trx.raw(
          `INSERT INTO reconciliation.blind_counts
             (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, route_code, denominations, total_contado)
           VALUES (?, ?, '1', '2026-01-02', 'SM36', 'cierre', '21', '{}'::jsonb, 100)`, [T, WH_TEST]);
      } catch (e) { rechazoCajaConRuta = /route_code_check/.test(e.message); }
      ok(rechazoCajaConRuta, 'NEGATIVA: un cierre CON route_code es RECHAZADO');
      throw new Error('__rb__');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    console.log('\n[3] El catalogo de rutas por sucursal');
    const tieneVista = (await knex.raw(`SELECT 1 FROM information_schema.tables
      WHERE table_schema='analytics' AND table_name='v_route_warehouse'`)).rows.length > 0;
    const tieneRw = (await knex.raw(`SELECT 1 FROM information_schema.tables
      WHERE table_schema='commercial' AND table_name='route_warehouses'`)).rows.length > 0;

    if (!tieneVista || !tieneRw) {
      noMedido('esta DB no tiene analytics.v_route_warehouse y/o commercial.route_warehouses');
    } else {
      const { rows } = await knex.raw(`
        SELECT w.code AS sucursal,
               count(*)::int rutas,
               count(*) FILTER (WHERE v.route_key ~* '^(RV|VECINAL)'
                                   OR coalesce(v.zona_name,'') ~* 'VECINAL')::int rv
          FROM commercial.route_warehouses rw
          JOIN commercial.warehouses w ON w.id = rw.warehouse_id AND w.tenant_id = rw.tenant_id
          JOIN analytics.v_route_warehouse v ON v.route_catalog_id = rw.route_id AND v.tenant_id = rw.tenant_id
         GROUP BY 1 ORDER BY 1`);
      if (!rows.length) {
        noMedido('no hay rutas asignadas a ninguna sucursal en esta DB');
      } else {
        ok(true, `${rows.length} sucursales con rutas: ${rows.map((r) => `${r.sucursal}:${r.rutas}`).join(' · ')}`);

        /**
         * La prueba que hace utilizable la pantalla: una clave ambigua del
         * catalogo (`501`/`502`, que reclaman ZAMORA y CANINDO) NO puede
         * aparecer dos veces dentro de la MISMA sucursal. Si apareciera, la
         * encargada tendria que adivinar cual es la suya.
         */
        const amb = (await knex.raw(`
          SELECT w.code, v.route_key, count(*)::int n
            FROM commercial.route_warehouses rw
            JOIN commercial.warehouses w ON w.id = rw.warehouse_id AND w.tenant_id = rw.tenant_id
            JOIN analytics.v_route_warehouse v ON v.route_catalog_id = rw.route_id AND v.tenant_id = rw.tenant_id
           GROUP BY 1,2 HAVING count(*) > 1`)).rows;
        ok(amb.length === 0,
          amb.length === 0
            ? 'ninguna clave de ruta se repite dentro de una misma sucursal (el alcance resuelve la ambiguedad del catalogo)'
            : `⚠️ ${amb.length} clave(s) repetida(s) en la misma sucursal: ${JSON.stringify(amb[0])}`);
      }
    }

    console.log('\n[4] El permiso esta REPARTIDO, no solo declarado');
    const perms = (await knex.raw(
      `SELECT role_name FROM role_permissions
        WHERE permissions -> 'STORE_ARQUEO_RUTA_CAPTURAR' = 'true'::jsonb ORDER BY role_name`)).rows
      .map((r) => r.role_name);
    if (!perms.length) {
      noMedido('nadie tiene STORE_ARQUEO_RUTA_CAPTURAR en esta DB (¿falta correr la migracion de reparto?)');
    } else {
      ok(perms.includes('encargado_tienda') && perms.includes('auxiliar_tienda'),
        `lo tienen encargado_tienda y auxiliar_tienda (${perms.join(', ')})`);
      // Lo que el pedido excluye explicitamente. Sin esta asercion, repartirlo de
      // mas pasaria por exito.
      ok(!perms.includes('cajero') && !perms.includes('piso_tienda'),
        'NEGATIVA: cajero y piso_tienda NO lo tienen (recibir una ruta es acto de encargada)');
    }
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nSM.36 arqueo de rutas → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
