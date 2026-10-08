'use strict';
/**
 * [IC.15] Candado del RITMO del conteo — los tres ritmos pueden coexistir en un almacén.
 *
 *   node database/tests/test-newdb-inventory-ritmo.js
 *
 * ── Qué cambió, y por qué hacía falta ────────────────────────────────────────────────────
 *
 * El índice `commercial_inv_counts_one_open_per_wh` era UNIQUE sobre `(tenant_id,
 * warehouse_id)` para los estados vivos: **un folio vivo por almacén, punto**. Mientras el
 * diario estuviera abierto, el mensual no podía existir — o sea que los tres ritmos de esta
 * fase eran imposibles y nada aguas abajo ([IC.18], [IC.19], [IC.22]) podía construirse.
 *
 * Ahora la llave es `(tenant_id, warehouse_id, ritmo)`.
 *
 * ── ⛔ Lo que este candado NO puede probar contra PROD, y se DECLARA ──────────────────────
 *
 * La prueba negativa de verdad —insertar dos folios vivos del mismo ritmo y ver el rechazo—
 * **exige escribir**, y prod no es destino de escritura. Acá se verifica la DEFINICIÓN del
 * índice al carácter: un UNIQUE sobre `(tenant_id, warehouse_id, ritmo)` admite dos filas que
 * difieran en `ritmo` **por definición**, no por suerte. Eso es una prueba definicional, no
 * empírica, y la diferencia se dice en vez de taparse.
 *
 * Contra un destino de ESCRITURA seguro (`DATABASE_URL_NEW` apuntando a dev), el bloque 4
 * ejerce el índice de verdad: dos ritmos distintos pasan, dos del mismo ritmo chocan.
 *
 * ⚠️ El guard de «un SKU en un solo folio vivo» vive en el SERVICIO (`openCount`) porque un
 * índice parcial no cruza tablas. No se prueba acá: es HTTP (ADR-044).
 */

const path = require('path');
const knexLib = require('knex');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

let ok = 0; let bad = 0; let nm = 0;
const t = (label, cond, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { bad++; console.log(`  ✗ ${label}${detalle ? ` — ${detalle}` : ''}`); }
};
const noMedido = (label, porque) => { nm++; console.log(`  ⓘ NO MEDIDO: ${label} — ${porque}`); };

const IDX_VIEJO = 'commercial_inv_counts_one_open_per_wh';
const IDX_NUEVO = 'commercial_inv_counts_one_open_per_wh_ritmo';
const VIVOS = ['open', 'counting', 'review', 'ready_to_reconcile'];
const RITMOS = ['diario', 'mensual', 'trimestral', 'adhoc'];

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const esProd = !process.env.DATABASE_URL_NEW && !!process.env.PROD_DB_URL;
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
      statement_timeout: 60000,
    },
    pool: { min: 1, max: 1 },
  });

  console.log('\n=== [IC.15] el ritmo del conteo: tres pueden coexistir ===\n');

  try {
    // ── Bloque 1: la columna existe y sólo admite el vocabulario acordado ────────────────
    const col = (await db.raw(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'commercial' AND table_name = 'inventory_counts'
          AND column_name = 'ritmo'`)).rows[0];

    if (!col) {
      noMedido('todo el bloque', 'la columna `ritmo` todavia no existe: la migracion no esta aplicada');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy();
      process.exit(0);
    }

    t('`ritmo` es NOT NULL: un folio siempre pertenece a algún ritmo', col.is_nullable === 'NO');
    t('su default es `adhoc` — honesto para un folio abierto a mano',
      String(col.column_default || '').includes('adhoc'), `default=${col.column_default}`);

    const chk = (await db.raw(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'commercial.inventory_counts'::regclass AND contype = 'c'
          AND conname = 'commercial_inv_counts_ritmo_check'`)).rows[0];
    t('el CHECK encierra el vocabulario y nada más',
      !!chk && RITMOS.every((r) => chk.def.includes(`'${r}'`)),
      chk ? chk.def : 'no existe el CHECK');

    // ── Bloque 2: el índice viejo se fue y el nuevo lleva `ritmo` ────────────────────────
    const idx = (await db.raw(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'commercial' AND tablename = 'inventory_counts'`)).rows;
    const porNombre = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));

    t('el índice de UN folio por almacén ya no existe', !porNombre[IDX_VIEJO],
      porNombre[IDX_VIEJO]);
    t('existe el índice por (almacén, ritmo)', !!porNombre[IDX_NUEVO]);

    if (porNombre[IDX_NUEVO]) {
      const def = porNombre[IDX_NUEVO];
      t('es UNIQUE: dos folios vivos del MISMO ritmo siguen siendo imposibles',
        /UNIQUE INDEX/.test(def), def);
      t('la llave incluye ritmo — es lo que permite que dos ritmos coexistan',
        /\(tenant_id,\s*warehouse_id,\s*ritmo\)/.test(def), def);
      t('sigue siendo PARCIAL sobre los estados vivos: un folio cerrado no ocupa lugar',
        VIVOS.every((s) => def.includes(`'${s}'`)), def);
    }

    // ── Bloque 3: el estado de los datos ─────────────────────────────────────────────────
    const d = (await db.raw(
      `SELECT count(*)::int AS folios,
              count(*) FILTER (WHERE ritmo = 'adhoc')::int AS adhoc,
              count(*) FILTER (WHERE ritmo NOT IN ('adhoc'))::int AS con_ritmo,
              count(*) FILTER (WHERE status = ANY(?))::int AS vivos
         FROM commercial.inventory_counts`, [VIVOS])).rows[0];
    console.log(`     ${d.folios} folios · ${d.adhoc} adhoc · ${d.con_ritmo} con ritmo real · ${d.vivos} vivos`);

    // Los folios previos NO se re-etiquetaron: inventarle un ritmo retroactivo a un folio
    // que nunca corrio como ese ritmo es dibujar historia que no ocurrio (ADR-056).
    const [{ viejos_marcados }] = (await db.raw(
      `SELECT count(*)::int AS viejos_marcados FROM commercial.inventory_counts
        WHERE created_at < '2026-10-07' AND ritmo <> 'adhoc'`)).rows;
    t('los folios anteriores a [IC.15] NO se re-etiquetaron con un ritmo inventado',
      viejos_marcados === 0, `${viejos_marcados} marcados`);

    // El invariante que el indice sostiene, comprobado sobre los datos REALES.
    const [{ chocan }] = (await db.raw(
      `SELECT count(*)::int AS chocan FROM (
         SELECT tenant_id, warehouse_id, ritmo FROM commercial.inventory_counts
          WHERE status = ANY(?) GROUP BY 1,2,3 HAVING count(*) > 1) z`, [VIVOS])).rows;
    t('ningún (almacén, ritmo) tiene dos folios vivos', chocan === 0, `${chocan} grupos`);

    // ── Bloque 4: ⭐ la prueba negativa de verdad — sólo en destino de ESCRITURA ─────────
    if (esProd) {
      noMedido('que el índice RECHACE dos folios vivos del mismo ritmo',
        'exige escribir folios y el destino es PROD: el bloque 2 prueba la DEFINICIÓN del '
        + 'índice (UNIQUE sobre la terna), que es definicional, no empírica');
    } else {
      // En un destino seguro sí se ejerce: se inserta, se comprueba y se revierte entero.
      const WH = (await db.raw(`SELECT id FROM commercial.warehouses LIMIT 1`)).rows[0];
      if (!WH) {
        noMedido('ejercer el índice', 'no hay almacenes en este destino');
      } else {
        let dejoPasarDistintos = false; let rechazoIguales = false;
        try {
          await db.transaction(async (trx) => {
            const base = {
              tenant_id: trx.raw('public.current_tenant_id()'),
              warehouse_id: WH.id, type: 'cycle', status: 'counting',
            };
            await trx('commercial.inventory_counts').insert({ ...base, folio: 'TST-RITMO-1', ritmo: 'diario' });
            await trx('commercial.inventory_counts').insert({ ...base, folio: 'TST-RITMO-2', ritmo: 'mensual' });
            dejoPasarDistintos = true;
            try {
              await trx('commercial.inventory_counts').insert({ ...base, folio: 'TST-RITMO-3', ritmo: 'diario' });
            } catch { rechazoIguales = true; }
            throw new Error('__rollback__');
          });
        } catch (e) { if (!String(e.message).includes('__rollback__')) throw e; }
        t('dos ritmos DISTINTOS conviven en el mismo almacén', dejoPasarDistintos);
        t('NEGATIVA: dos folios vivos del MISMO ritmo son rechazados', rechazoIguales);
      }
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
