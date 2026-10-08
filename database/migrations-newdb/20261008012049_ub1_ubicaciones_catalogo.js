'use strict';
/**
 * `[UB.1]` — Catálogo de ubicaciones (Fase UB, ADR-090): `commercial.warehouse_bins` gana las
 * partes del código, la familia, el tipo, el estado y el orden de recorrido.
 *
 * Se EXTIENDE la tabla de WMS-REC (no se crea una paralela: regla "nunca copias de tablas").
 *
 * ── Lo medido en prod antes de escribir esto (solo lectura, 2026-10-08) ─────────────────────────
 *  · 1 fila: código `40174`, etiqueta "Rack", almacén 03 (8ESQ), activa, con 60 unidades en
 *    `stock_lot_locations`. No cumple el formato nuevo → queda como familia `legado`, intacta.
 *  · `active` sólo se escribe al crear (default true); nadie la pone en false. Por eso el estado
 *    nuevo se deriva de ella sin ambigüedad y un CHECK los mantiene de acuerdo.
 *
 * ── El código ───────────────────────────────────────────────────────────────────────────────────
 *  `[T|B][pasillo A–Z/Ñ][rack 01–99][nivel 1–6]` — ej. `BA053`. Es la MISMA expresión que
 *  `LOCATION_CODE_RE` en `libs/contracts/src/http/warehouse-locations.contract.ts`; la prueba de
 *  ese archivo la fija. La base la exige sólo a la familia `ubicacion`: lo `legado` (códigos libres
 *  que creó el Andén, como `R-12`) y las otras familias (carretas, espera…) siguen su propia regla.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.warehouse_bins';
const CODE_RE = '^([TB])([A-ZÑ])(0[1-9]|[1-9][0-9])([1-6])$';

const COLUMNAS = [
  ['familia', (t) => t.string('familia', 20).notNullable().defaultTo('legado')],
  ['zona', (t) => t.string('zona', 1)],
  ['pasillo', (t) => t.string('pasillo', 2)],
  ['rack', (t) => t.smallint('rack')],
  ['nivel', (t) => t.smallint('nivel')],
  ['tipo', (t) => t.string('tipo', 20)],
  ['estado', (t) => t.string('estado', 12).notNullable().defaultTo('activa')],
  ['motivo_estado', (t) => t.string('motivo_estado', 300)],
  ['pick_sequence', (t) => t.integer('pick_sequence')],
  ['created_by', (t) => t.uuid('created_by')],
];

const CHECKS = {
  ck_wh_bins_familia: `familia IN ('ubicacion','carreta','espera','contenedor','estiba','legado')`,
  ck_wh_bins_zona: `zona IS NULL OR zona IN ('T','B')`,
  ck_wh_bins_rack: `rack IS NULL OR rack BETWEEN 1 AND 99`,
  ck_wh_bins_nivel: `nivel IS NULL OR nivel BETWEEN 1 AND 6`,
  ck_wh_bins_tipo: `tipo IS NULL OR tipo IN ('surtido','reserva','tienda_piso','tienda_cabecera','recepcion','cuarentena','merma')`,
  ck_wh_bins_estado: `estado IN ('activa','bloqueada','baja')`,
  // Una sola verdad: `active` (que leen el Andén y la recepción) es lo mismo que "no dada de baja".
  // Una bloqueada sigue activa: su contenido existe, sólo no se sugiere.
  ck_wh_bins_estado_active: `active = (estado <> 'baja')`,
  // Bloquear o dar de baja exige decir por qué (FASE_UB §7).
  ck_wh_bins_motivo: `estado = 'activa' OR motivo_estado IS NOT NULL`,
  // El formato nuevo: partes completas, código = concatenación, y la expresión del contrato.
  ck_wh_bins_formato: `familia <> 'ubicacion' OR (
      zona IS NOT NULL AND pasillo IS NOT NULL AND rack IS NOT NULL AND nivel IS NOT NULL
      AND code = zona || pasillo || lpad(rack::text, 2, '0') || nivel::text
      AND code ~ '${CODE_RE}')`,
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const [col, def] of COLUMNAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('warehouse_bins', col))) {
      await knex.schema.withSchema('commercial').alterTable('warehouse_bins', def);
    }
  }

  // Backfill: lo que ya cumpla el formato pasa a familia `ubicacion` con sus partes; el resto queda
  // `legado`. El estado sale de `active` (hoy nadie lo pone en false).
  await knex.raw(`
    UPDATE ${T} SET
      familia = 'ubicacion',
      zona    = substr(upper(code), 1, 1),
      pasillo = substr(upper(code), 2, 1),
      rack    = substr(code, 3, 2)::smallint,
      nivel   = substr(code, 5, 1)::smallint,
      code    = upper(code)
    WHERE familia = 'legado' AND upper(code) ~ '${CODE_RE}'`);
  await knex.raw(`
    UPDATE ${T} SET estado = 'baja', motivo_estado = COALESCE(motivo_estado, 'Inactiva antes de la Fase UB')
    WHERE active = false AND estado <> 'baja'`);
  // Orden de recorrido por defecto (misma fórmula que defaultPickSequence del contrato).
  await knex.raw(`
    UPDATE ${T} SET pick_sequence =
        (CASE WHEN zona = 'T' THEN 0 ELSE 1 END) * 1000000
      + (CASE WHEN pasillo = 'Ñ' THEN 29 ELSE (ascii(pasillo) - 64) * 2 END) * 10000
      + rack * 10 + nivel
    WHERE familia = 'ubicacion' AND pick_sequence IS NULL`);

  for (const [nombre, expr] of Object.entries(CHECKS)) {
    const existe = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = '${T}'::regclass`,
      [nombre],
    );
    if (!existe.rows.length) await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
  }

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_commercial_wh_bins_recorrido ON ${T} (tenant_id, warehouse_id, pick_sequence)`,
  );
  await knex.raw(`COMMENT ON TABLE ${T} IS
    'Catálogo de ubicaciones (Fase UB, ADR-090; nació en WMS-REC). Familia ubicacion = código [T|B][pasillo][rack 01-99][nivel 1-6], ej. BA053; legado = código libre previo. Nunca se borra: estado activa/bloqueada/baja.'`);
};

exports.down = async function down(knex) {
  for (const nombre of Object.keys(CHECKS)) {
    await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${nombre}`);
  }
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commercial_wh_bins_recorrido`);
  for (const [col] of [...COLUMNAS].reverse()) {
    if (await knex.schema.withSchema('commercial').hasColumn('warehouse_bins', col)) {
      await knex.schema.withSchema('commercial').alterTable('warehouse_bins', (t) => t.dropColumn(col));
    }
  }
};
