/**
 * [PERF.5b] La OTRA MITAD del índice de `20260924170000`: sin esto rinde 2.5× y bajando.
 *
 * ── Por qué es una migración aparte ──────────────────────────────────────────────────────────
 * Porque no es un índice: es **política de mantenimiento**. Mezclarlas haría que revertir una
 * arrastre la otra, y son decisiones distintas.
 *
 * ── El número que lo justifica ───────────────────────────────────────────────────────────────
 * Un `Index Only Scan` sólo evita el viaje al heap en las páginas marcadas en el MAPA DE
 * VISIBILIDAD, y ese mapa lo pinta el VACUUM. Medido sobre `kepler_ods.kdpv_prod_util`:
 *
 *     VM  56.5 %  →  33,048 buffers   (el estado de hoy)
 *     VM  99.7 %  →     550 buffers   (60× mejor, y es el "76×" que se publica por ahí)
 *
 * Con el umbral de hoy (`scale_factor` global 0.2 sobre 380,819 filas) el autovacuum pide
 * **76,036 tuplas muertas** para disparar, y la tabla tiene **2,010** (`n_tup_upd = 3,096`
 * histórico). O sea: **no dispara en ~50 días**, mientras las páginas sin bit de visibilidad ya
 * pasaron de 25 a ~974 en 41 h. El `relallvisible` de `pg_class` está congelado desde el
 * 2026-09-22 16:09:50.
 *
 * La diferencia entre "76×" y "2.5×" **no es el índice, es el vacuum**.
 *
 * ── Por qué estos valores ────────────────────────────────────────────────────────────────────
 * `scale_factor = 0.01` + `threshold = 1000` → dispara con ~4,808 tuplas muertas en vez de 76,036.
 * Es una tabla de 3,528 páginas (28 MB): un vacuum suyo es barato y no compite con nada.
 * ⛔ Es un `ALTER TABLE ... SET (...)`, o sea sólo cambia parámetros de almacenamiento: **no
 * reescribe la tabla, no toma lock exclusivo largo, no cambia un solo dato**.
 *
 * ⚠️ El primer VACUUM hay que dispararlo a mano una vez: esta migración baja el umbral para las
 * PRÓXIMAS veces, no rellena el mapa de visibilidad de hoy.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE kepler_ods.kdpv_prod_util
    SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000)`);

  const { rows } = await knex.raw(
    `SELECT reloptions FROM pg_class WHERE oid = 'kepler_ods.kdpv_prod_util'::regclass`);
  const o = (rows[0] && rows[0].reloptions) || [];
  if (!o.some((x) => String(x).includes('autovacuum_vacuum_scale_factor=0.01'))) {
    throw new Error('El ALTER TABLE no quedó: reloptions = ' + JSON.stringify(o));
  }
  console.log('  ✓ autovacuum de kdpv_prod_util: dispara con ~4,808 muertas en vez de 76,036.');
  console.log('  ⚠️ Correr UNA vez a mano para rellenar el mapa de visibilidad de hoy:');
  console.log('     VACUUM (ANALYZE) kepler_ods.kdpv_prod_util;');
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE kepler_ods.kdpv_prod_util
    RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)`);
};
