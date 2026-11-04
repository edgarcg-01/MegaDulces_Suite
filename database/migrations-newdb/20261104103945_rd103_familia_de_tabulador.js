'use strict';
/**
 * `[RD.103.1]` — La FAMILIA del tabulador: cada versión de `commercial.commission_scales` y cada
 * fila de «Quién cobra» (`commercial.commission_route_config`) dice si es de Ruta Directa,
 * vecinal o TLMK.
 *
 * ── Por qué (Edgar, 2026-11-04) ─────────────────────────────────────────────────────────────
 * «Debemos dejar un sistema de configuración para determinar estos parámetros»: las vecinales
 * SÍ comisionan (`[RD.107]`) y su tabulador no puede ser el de Ruta Directa — con él casi ninguna
 * cobraría (venden ~$52k–$327k por quincena; el primer escalón RD empieza en $189,999.99).
 *
 * ── Lo medido antes (sólo lectura, prod sid 7688376744939610156, 2026-11-04) ──────────────────
 *  · `commission_scales`: UNA versión viva, `RD-2026` desde el 2026-01-01.
 *  · `commission_route_config`: 13 filas, todas con `scale_id` = esa versión. El motor NO lee
 *    `scale_id`: elige la escala vigente por fecha, una para todas (`loadScale()`).
 *  · ⚠️ Riesgo latente que esto prepara para cerrar (`[RD.103.2]`): «Quién cobra» acepta cualquier
 *    código, así que dar de alta una vecinal la pagaría con el tabulador RD sin aviso.
 *
 * ── Lo que hace ─────────────────────────────────────────────────────────────────────────────
 *  · `familia` en las dos tablas, `NOT NULL DEFAULT 'ruta_directa'`, con CHECK de la lista.
 *    ⛔ La familia va en la FILA de «Quién cobra», no se deduce del código: 2V001 es código
 *    vecinal y, por «la comisión sigue al chofer», cobra con el tabulador de Ruta Directa (D-V2).
 *  · Índice `(tenant_id, familia, valid_from)` para elegir la versión vigente de cada familia.
 *
 * ⛔ Compatible con la API desplegada (expand): el DEFAULT hace que los dos caminos que insertan
 *    hoy —`createScaleVersion()` y `CommissionPadronService.crear()`— y las semillas sigan
 *    escribiendo sin mandar la columna. Lo existente queda en `ruta_directa`: ningún número cambia.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const FAMILIAS = ['ruta_directa', 'vecinal', 'tlmk'];
const TABLAS = [
  { tabla: 'commission_scales', check: 'commission_scales_familia_valida' },
  { tabla: 'commission_route_config', check: 'commission_route_config_familia_valida' },
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const { tabla, check } of TABLAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn(tabla, 'familia'))) {
      await knex.raw(`ALTER TABLE commercial.${tabla}
        ADD COLUMN familia varchar(20) NOT NULL DEFAULT 'ruta_directa'`);
    }
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [check]);
    if (!rows.length) {
      await knex.raw(`ALTER TABLE commercial.${tabla} ADD CONSTRAINT ${check}
        CHECK (familia IN (${FAMILIAS.map((f) => `'${f}'`).join(', ')}))`);
    }
    await knex.raw(`COMMENT ON COLUMN commercial.${tabla}.familia IS
      'RD.103.1 - ruta_directa | vecinal | tlmk. Cada familia tiene sus propias versiones del tabulador; la fila de Quien cobra elige con cual cobra (no se deduce del codigo de ruta).'`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_commission_scales_familia_vigencia
    ON commercial.commission_scales (tenant_id, familia, valid_from)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. ⛔ Se niega si ya hay algo fuera de Ruta Directa:
 *  borrar la columna lo volvería tabulador RD en silencio. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const { tabla } of TABLAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn(tabla, 'familia'))) continue;
    const { rows: [x] } = await knex.raw(
      `SELECT count(*)::int n FROM commercial.${tabla} WHERE familia <> 'ruta_directa'`);
    if (x.n > 0) {
      throw new Error(`commercial.${tabla} tiene ${x.n} fila(s) que no son de Ruta Directa: `
        + 'quitar la familia las pagaría con el tabulador RD. Bórralas o pásalas a ruta_directa primero.');
    }
  }
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commission_scales_familia_vigencia`);
  for (const { tabla, check } of TABLAS) {
    await knex.raw(`ALTER TABLE commercial.${tabla} DROP CONSTRAINT IF EXISTS ${check}`);
    await knex.raw(`ALTER TABLE commercial.${tabla} DROP COLUMN IF EXISTS familia`);
  }
};
