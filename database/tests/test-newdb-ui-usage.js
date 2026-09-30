'use strict';
/**
 * [UX.0] Candado de la telemetría de uso — `analytics.ui_usage` / `ui_usage_users`.
 *
 *   node database/tests/test-newdb-ui-usage.js
 *
 * Sólo lee.
 *
 * ── Qué protege ──────────────────────────────────────────────────────────────────────────
 *
 * Esta tabla existe para decidir **qué pantalla se audita y cuál se retira** entre 285. O sea
 * que un defecto acá no produce un número feo: produce una decisión equivocada sobre en qué
 * gastar semanas. Tres cosas pueden fallar sin que nada se vea roto:
 *
 *  1. **Que el medidor se muera y nadie lo note.** «0 hits» y «nadie la usa» se escriben igual.
 *     Por eso su latido (`ui_usage_flush`) tiene el umbral más estrecho del tablero, y acá se
 *     verifica que ESTÉ, no que esté verde.
 *  2. **Que se cuele un identificador en `ruta`.** El interceptor guarda el PATRÓN de Nest
 *     (`/commercial/orders/:id`). Si alguna vez guardara la URL cruda, esta tabla pasaría a
 *     tener UUIDs de clientes y folios adentro — y al ser una tabla de métricas, nadie la
 *     miraría con ese criterio. El invariante se comprueba sobre las filas REALES, que es más
 *     fuerte que probar el regex aislado: cubre para siempre, no una vez.
 *  3. **Que la acumulación sume mal.** `ms_max` no puede exceder `ms_total`, `errores` no puede
 *     exceder `hits`. Son las dos formas de un UPSERT mal escrito.
 *
 * ⛔ Lo que este candado NO puede hacer, y lo declara: **ejercer el UPSERT**. El rol de lectura
 * corre con `default_transaction_read_only` —que es como debe estar— así que no puede insertar
 * ni crear una tabla temporal. La acumulación la ejerce la app en los primeros 60 s de vida, y
 * lo que la vigila después son los invariantes de coherencia de arriba.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [UX.0] telemetría de uso del API ===\n');
  try {
    const [{ hay_usage, hay_users }] = (await db.raw(`
      SELECT to_regclass('analytics.ui_usage')       IS NOT NULL AS hay_usage,
             to_regclass('analytics.ui_usage_users') IS NOT NULL AS hay_users`)).rows;
    if (!hay_usage || !hay_users) {
      noMedido('todo el candado', 'la migración 20260930120000 no corrió contra este destino');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy();
      process.exit(0);
    }
    t('las dos tablas existen', true);

    // ── 1. La llave: el grano es (dia, metodo, ruta, rol). Sin eso la acumulación se pisa ──
    {
      const { rows } = await db.raw(`
        SELECT a.attname FROM pg_index i
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid='analytics.ui_usage'::regclass AND i.indisprimary
         ORDER BY a.attnum`);
      const pk = rows.map((r) => r.attname);
      t('la PK de ui_usage es (tenant_id, fecha, metodo, ruta, role_name)',
        ['tenant_id', 'fecha', 'metodo', 'ruta', 'role_name'].every((c) => pk.includes(c))
          && pk.length === 5, pk.join(','));
      const { rows: r2 } = await db.raw(`
        SELECT a.attname FROM pg_index i
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid='analytics.ui_usage_users'::regclass AND i.indisprimary`);
      t('ui_usage_users dedupe por (tenant, fecha, ruta, usuario) — la PK, no un contador',
        r2.length === 4, r2.map((x) => x.attname).join(','));
    }

    // ── 2. El GRANT: sin INSERT/UPDATE el interceptor descarga a la nada ────────────────
    {
      const [g] = (await db.raw(`
        SELECT has_table_privilege('app_runtime','analytics.ui_usage','INSERT') AS ins,
               has_table_privilege('app_runtime','analytics.ui_usage','UPDATE') AS upd,
               has_table_privilege('app_runtime','analytics.ui_usage_users','INSERT') AS ins2`)).rows;
      t('app_runtime puede escribir las dos (sin esto la descarga falla en silencio)',
        g.ins === true && g.upd === true && g.ins2 === true, JSON.stringify(g));
    }

    // ── 3. PRUEBA NEGATIVA del detector de privacidad, con filas fabricadas ────────────
    // Se prueba EL DETECTOR, no el normalizador: tiene que decir que sí sobre una ruta con
    // identificador y que no sobre un patrón legítimo. Si el detector no discrimina, la
    // aserción 4 estaría verde por no saber mirar.
    {
      const { rows } = await db.raw(`
        WITH f(caso, ruta) AS (VALUES
          ('patron sano',    '/commercial/orders/:id'),
          ('patron plano',   '/almacen/inventory/diferencias'),
          ('uuid crudo',     '/commercial/orders/9f3c1e20-1c4a-4f2e-9b7d-2a5c8e1f0d33'),
          ('numero crudo',   '/finanzas/poliza/9910233'),
          ('hash largo',     '/x/a1b2c3d4e5f6a7b8c9d0e1f2'))
        SELECT caso, (ruta ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-' OR ruta ~ '/[0-9]{4,}'
                      OR ruta ~ '/[0-9a-fA-F]{24,}') AS sucia FROM f`);
      const v = Object.fromEntries(rows.map((r) => [r.caso, r.sucia]));
      t('NEGATIVA: un patrón sano NO se marca como sucio', v['patron sano'] === false);
      t('NEGATIVA: una ruta plana tampoco', v['patron plano'] === false);
      t('POSITIVA: un UUID crudo se detecta', v['uuid crudo'] === true);
      t('POSITIVA: un folio numérico crudo se detecta', v['numero crudo'] === true);
      t('POSITIVA: un hash largo se detecta', v['hash largo'] === true);
    }

    // ── 4. El invariante, sobre las filas REALES ───────────────────────────────────────
    {
      const [r] = (await db.raw(`
        SELECT count(*)::int AS filas,
               count(*) FILTER (WHERE ruta ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
                                   OR ruta ~ '/[0-9]{4,}'
                                   OR ruta ~ '/[0-9a-fA-F]{24,}')::int AS sucias,
               count(*) FILTER (WHERE ms_max > ms_total)::int  AS ms_incoherente,
               count(*) FILTER (WHERE errores > hits)::int     AS err_incoherente,
               count(*) FILTER (WHERE left(ruta,1) <> '/')::int AS sin_barra,
               count(*) FILTER (WHERE ruta ILIKE '%?%')::int    AS con_query
          FROM analytics.ui_usage`)).rows;
      if (Number(r.filas) === 0) {
        noMedido('los invariantes sobre datos reales',
          'la tabla está vacía: el interceptor todavía no corrió en este destino');
      } else {
        t(`⛔ ninguna ruta guarda un identificador (${r.filas} filas revisadas)`,
          Number(r.sucias) === 0, `sucias=${r.sucias}`);
        t('ninguna guarda el query string', Number(r.con_query) === 0, `n=${r.con_query}`);
        t('ms_max nunca excede ms_total (acumulación coherente)',
          Number(r.ms_incoherente) === 0, `n=${r.ms_incoherente}`);
        t('errores nunca exceden hits', Number(r.err_incoherente) === 0, `n=${r.err_incoherente}`);
        t('toda ruta empieza con /', Number(r.sin_barra) === 0, `n=${r.sin_barra}`);
      }
      noMedido('el UPSERT que acumula',
        'el rol de lectura no puede insertar (default_transaction_read_only, que está bien): '
        + 'lo ejerce la app en sus primeros 60 s y lo vigilan los invariantes de coherencia');
    }

    // ── 5. El latido ───────────────────────────────────────────────────────────────────
    {
      const { rows } = await db.raw(
        `SELECT status, last_finish, rows_affected, error FROM analytics.cron_runs
          WHERE job_key = 'ui_usage_flush' ORDER BY last_finish DESC LIMIT 1`);
      if (!rows.length) {
        noMedido('el latido de la descarga',
          'el job `ui_usage_flush` todavía no reportó: el interceptor no está desplegado');
      } else {
        const edadMin = (Date.now() - new Date(rows[0].last_finish).getTime()) / 60000;
        t(`el latido es reciente (${edadMin.toFixed(1)} min < 60)`, edadMin < 60,
          `status=${rows[0].status} error=${rows[0].error || '-'}`);
      }
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
