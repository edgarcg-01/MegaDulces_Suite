/**
 * [VP.5.4] Retira `identity.knex_migrations` — el ledger fantasma de GOTCHAS §29.
 *
 * ── EL PROBLEMA ──────────────────────────────────────────────────────────────────────────
 * El `search_path` de esta base arranca en `identity`. Un cliente knex que corra migraciones **sin**
 * `schemaName` escribe su ledger en `identity.knex_migrations`, que el knexfile real
 * (`schemaName: 'public'`) **no lee**. El resultado es el peor de los dos mundos: el DDL SÍ se
 * aplicó, pero para el CLI esas migraciones siguen **pendientes** — y el próximo `migrate:latest`
 * las re-corre.
 *
 * No es hipotético. Medido en prod el 2026-09-07: **5 filas** en la tabla fantasma
 * (`v_sellout_daily`, `mv_sellout_monthly`, `sellout_monto_neto_descuento`,
 * `vendor_identity_tlmk_ph`, `commercial_sellout_analysis_perm_backfill`), con sus objetos ya
 * creados y el CLI listándolas como pendientes. Una de ellas
 * (`sellout_monto_neto_descuento`) hace `DROP MATERIALIZED VIEW mv_kepler_sales_daily CASCADE` y
 * recrea la cadena `WITH NO DATA`: re-correrla habría dejado el sell-out sin su rollup hasta el
 * refresh de las 06:20. Lo único que lo evitó fue su guard por columna.
 *
 * ── POR QUÉ RETIRAR LA TABLA Y NO SÓLO ARREGLAR AL ESCRITOR ──────────────────────────────
 * El código de este repo YA está bien: las **10** configuraciones de migraciones llevan
 * `schemaName: 'public'`, y `new-database.module.ts` hasta documenta este incidente con el candado
 * puesto. El escritor que sigue llenándola está **fuera del repo** (otra máquina, un checkout viejo,
 * o un comando ad-hoc) — la última escritura fue el 2026-09-07 a las 18:02.
 *
 * Contra un escritor que no se puede editar desde acá, borrar la tabla no es la cura: es el
 * **detector**. Si reaparece, el candado `test-newdb-knex-ledger-unico.js` lo dice al día siguiente
 * en vez de que se descubra semanas después, cuando ya hay cinco migraciones fantasma y una de
 * ellas dropea una matvista.
 *
 * ── EL GUARD: NO SE BORRA REGISTRO QUE NO ESTÉ EN LA TABLA BUENA ─────────────────────────
 * Antes de dropear se verifica que **cada** fila de `identity` exista también en `public`. Si falta
 * una, la migración ABORTA: borrar el único registro de una migración aplicada la volvería
 * "pendiente" para siempre y la próxima corrida la re-aplicaría. Es exactamente el daño que esta
 * migración existe para prevenir, y sería absurdo causarlo al prevenirlo.
 *
 * ⚠️ En PROD esto BORRA UNA TABLA — la regla del proyecto pide autorización explícita. Aplicar sólo
 * con visto bueno, y después de que el candado pase.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const existe = (await knex.raw(
    `SELECT to_regclass('identity.knex_migrations') IS NOT NULL AS ok`)).rows[0].ok;
  if (!existe) {
    // eslint-disable-next-line no-console
    console.log('  [VP.5.4] identity.knex_migrations no existe en este destino — nada que retirar.');
    return;
  }

  // El guard. Cada fila del ledger fantasma tiene que estar también en el bueno.
  const { rows: huerfanas } = await knex.raw(`
    SELECT i.name FROM identity.knex_migrations i
     WHERE NOT EXISTS (SELECT 1 FROM public.knex_migrations p WHERE p.name = i.name)
     ORDER BY i.name`);
  if (huerfanas.length) {
    throw new Error(
      `[VP.5.4] ABORTA: ${huerfanas.length} migración(es) sólo están registradas en el ledger `
      + `fantasma → ${huerfanas.map((r) => r.name).join(', ')}. `
      + 'Reconciliarlas a public.knex_migrations ANTES de retirar la tabla: borrar el único '
      + 'registro de una migración aplicada la vuelve "pendiente" y la próxima corrida la re-aplica.',
    );
  }

  const n = (await knex.raw(`SELECT count(*)::int n FROM identity.knex_migrations`)).rows[0].n;
  // eslint-disable-next-line no-console
  console.log(`  [VP.5.4] ${n} fila(s) reconciliadas en public — se retira el ledger fantasma.`);

  await knex.raw(`DROP TABLE IF EXISTS identity.knex_migrations`);
  await knex.raw(`DROP TABLE IF EXISTS identity.knex_migrations_lock`);
};

exports.down = async function () {
  // Sin `down` a propósito: recrear la tabla fantasma es exactamente el estado que esta migración
  // vino a eliminar. Si hiciera falta volver atrás, el ledger bueno (`public.knex_migrations`)
  // conserva todo el registro — no se perdió nada que reponer.
};
