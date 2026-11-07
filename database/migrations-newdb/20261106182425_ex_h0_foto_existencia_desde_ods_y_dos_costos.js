'use strict';
/**
 * `[EX.H0]` — **La foto diaria de inventario lee la MISMA existencia que la pantalla Existencia, y
 * guarda el costo del día con el que se va a valuar su historia.** Es la capa C0 de «Consulta
 * históricos» (Existencia): sin esto, el histórico tendría que reconstruir el costo de cada día y
 * seguiría mostrando el CEDIS congelado.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06) ────────────────────────────────────────
 *  · La foto (AB.0b) lee `commercial.stock` (acierta 91 % contra el POS); la pantalla Existencia lee
 *    `analytics.v_erp_stock_on_hand` (100 %). En el CEDIS la diferencia no es ruido: la foto repetía
 *    el mismo saldo todos los días (205 pares), mientras la vista —arbitrada contra el reporte del
 *    propio Kepler, `[IC.CEDIS.12]`— da 304 pares y +75 % de unidades. MD-32 también salía congelado
 *    y NO está en la vista (tampoco en la pantalla Existencia).
 *  · En las sucursales 01–08 las dos fuentes están en la MISMA unidad: razón mediana 1.000 y ≥ 99.9 %
 *    de los pares iguales (±2 %). Cambiar de fuente no rompe la serie de unidades de 01–08.
 *  · El `valor` que guarda la foto es el costo del CATÁLOGO con impuesto (IEPS): infla 15–25 %. No se
 *    toca (es la serie que ya existe); se AGREGAN dos costos honestos al lado.
 *
 * ── Lo que agrega ────────────────────────────────────────────────────────────────────────────
 *  stock_snapshots (por par almacén × producto × día):
 *   · `erp_unit_cost` ........ costo del ERP de ESE almacén (`kdik.c16`, `analytics.v_kepler_unit_cost`),
 *                              en la unidad de `unidades`. ⛔ Es el costo de la ÚLTIMA ENTRADA, NO un
 *                              promedio — medido 2026-11-06 con dos métodos: casa con la última entrada
 *                              en ≈99 % del subconjunto que distingue, con c8/c5 en 0.0–0.3 %. El
 *                              comentario KX de `existencia.service.ts` que lo llamaba «promedio
 *                              ponderado» está mal. Es el costo con que valúa HOY la pantalla
 *                              Existencia y el testigo de unidad del peldaño estándar.
 *   · `standard_unit_cost` ... costo ESTÁNDAR de Kepler sin impuesto (`kdii.c77`,
 *                              `analytics.v_kepler_standard_cost`), en el peldaño que casa con
 *                              `erp_unit_cost` a menos de 2× (la existencia viene en la unidad de
 *                              Kepler: pieza, paquete o caja según el SKU).
 *   · `standard_cost_rule` ... CÓMO se eligió: `erp_rung` (casa con el ERP) · `base_unit_no_witness`
 *                              (sin costo del ERP: unidad base que declara Kepler) · `doubtful_unit`
 *                              (ningún peldaño casa: SIN valor) · `none` (sin estándar).
 *  stock_snapshot_coverage (por almacén × día):
 *   · `stock_source` ............................ de qué fuente salió la existencia de ese día.
 *     DEFAULT `commercial.stock`: las filas que ya existen (y las que escriba el código viejo) lo
 *     leen sin reescribir la tabla; así el histórico puede DECLARAR que los días previos al cambio
 *     no son comparables en el CEDIS.
 *   · `erp_value_known` / `erp_missing_pairs`
 *   · `standard_value_known` / `standard_missing_pairs` / `standard_doubtful_pairs`
 *     ⛔ `*_value_known` es la suma de lo que SÍ tiene costo; se lee SIEMPRE junto con sus pares
 *     faltantes. No se guarda NULL-si-falta-uno (como `valor_total`): con ~200 pares dudosos al día
 *     el total sería NULL siempre y el histórico no tendría nada que mostrar. El nombre lo dice.
 *
 * ── `reservadas` / `disponibles` pasan a admitir NULL ───────────────────────────────────────
 * La vista del ERP no trae apartados (medido: 1 fila de 53,223 tenía apartado en `commercial.stock`).
 * Escribir 0 diría «no había nada apartado», que nadie midió (ADR-056). Desde EX.H0 quedan NULL =
 * no medido. Lectores medidos: `import-replenishment-plan.js` y `pq-m1-comprador-vs-sugerido.js`
 * leen sólo `unidades`; nadie lee estas dos columnas.
 *
 * Sin reescritura de tabla: columnas nuevas nullable, sin default. El CHECK se valida al crearse
 * sobre una columna que nace vacía (un barrido de ~1 M filas, segundos, fuera de horario). No
 * actualiza ninguna fila.
 *
 * ⚠️ Aplicala ANTES de soltar el código: la foto corre a las 23:50 y un día que no se toma no se
 *    recupera. El servicio igual se defiende — si no encuentra estas columnas, fotografía con la
 *    fuente nueva y el esquema viejo (sin costos del día) y el latido sale en ERROR.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const SNAP = 'analytics.stock_snapshots';
const COV = 'analytics.stock_snapshot_coverage';
const REGLAS = `('erp_rung','base_unit_no_witness','doubtful_unit','none')`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const agrega = async (schema, tabla, col, tipo) => {
    if (!(await knex.schema.withSchema(schema).hasColumn(tabla, col))) {
      await knex.raw(`ALTER TABLE ${schema}.${tabla} ADD COLUMN ${col} ${tipo}`);
      console.log(`  [EX.H0] +${schema}.${tabla}.${col}`);
    }
  };

  await agrega('analytics', 'stock_snapshots', 'erp_unit_cost', 'numeric(18,6)');
  await agrega('analytics', 'stock_snapshots', 'standard_unit_cost', 'numeric(18,6)');
  await agrega('analytics', 'stock_snapshots', 'standard_cost_rule', 'text');

  // La procedencia la pone QUIEN ESCRIBE la fila, no la hora del DDL. El código nuevo siempre la
  // escribe explícita; el DEFAULT cubre lo que escribe el código VIEJO (las ~420 filas que ya
  // existen, y cualquier noche con el código viejo después de esta migración: una vuelta atrás o un
  // despliegue frenado). Un DEFAULT constante es sólo metadatos (PG ≥ 11): no reescribe la tabla.
  // ⚠️ Residuo declarado: si el código NUEVO corriera ANTES de esta migración (el carril de entrega
  // lo impide: frena el despliegue con migraciones pendientes), esas noches también leerían
  // 'commercial.stock' aunque salieron de la vista.
  await agrega('analytics', 'stock_snapshot_coverage', 'stock_source', `text DEFAULT 'commercial.stock'`);
  await knex.raw(`ALTER TABLE ${COV} ALTER COLUMN stock_source SET DEFAULT 'commercial.stock'`);
  await agrega('analytics', 'stock_snapshot_coverage', 'erp_value_known', 'numeric(18,4)');
  await agrega('analytics', 'stock_snapshot_coverage', 'erp_missing_pairs', 'integer');
  await agrega('analytics', 'stock_snapshot_coverage', 'standard_value_known', 'numeric(18,4)');
  await agrega('analytics', 'stock_snapshot_coverage', 'standard_missing_pairs', 'integer');
  await agrega('analytics', 'stock_snapshot_coverage', 'standard_doubtful_pairs', 'integer');

  // DROP NOT NULL sobre una columna que ya admite NULL es un no-op: idempotente por naturaleza.
  await knex.raw(`ALTER TABLE ${SNAP} ALTER COLUMN reservadas DROP NOT NULL`);
  await knex.raw(`ALTER TABLE ${SNAP} ALTER COLUMN disponibles DROP NOT NULL`);

  const yaCheck = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'stocksnap_standard_rule_valida' AND conrelid = ?::regclass`,
    [SNAP],
  );
  if (yaCheck.rowCount === 0) {
    await knex.raw(`ALTER TABLE ${SNAP} ADD CONSTRAINT stocksnap_standard_rule_valida
                      CHECK (standard_cost_rule IS NULL OR standard_cost_rule IN ${REGLAS})`);
    console.log('  [EX.H0] +CHECK stocksnap_standard_rule_valida');
  }

  await knex.raw(`COMMENT ON COLUMN ${SNAP}.erp_unit_cost IS 'EX.H0 — costo del ERP de ESE almacén (kdik.c16 = costo de la ÚLTIMA ENTRADA, no promedio; v_kepler_unit_cost), en la unidad de unidades. NULL = sin costo del ERP.'`);
  await knex.raw(`COMMENT ON COLUMN ${SNAP}.standard_unit_cost IS 'EX.H0 — costo estándar de Kepler SIN impuesto (kdii.c77) vigente al fotografiar, en el peldaño que casa con erp_unit_cost a <2×. NULL = sin estándar o unidad dudosa (ver standard_cost_rule), nunca 0.'`);
  await knex.raw(`COMMENT ON COLUMN ${SNAP}.standard_cost_rule IS 'EX.H0 — erp_rung | base_unit_no_witness | doubtful_unit | none. NULL = fila anterior a EX.H0.'`);
  await knex.raw(`COMMENT ON COLUMN ${SNAP}.reservadas IS 'Apartados. NULL = no medido: desde EX.H0 la fuente (v_erp_stock_on_hand) no trae apartados.'`);
  await knex.raw(`COMMENT ON COLUMN ${COV}.stock_source IS 'EX.H0 — de qué fuente salió la existencia ese día: analytics.v_erp_stock_on_hand (desde EX.H0) o commercial.stock (antes; CEDIS y MD-32 congelados).'`);
  await knex.raw(`COMMENT ON COLUMN ${COV}.standard_value_known IS 'EX.H0 — suma de unidades × standard_unit_cost de los pares que SÍ tienen estándar. Parcial por diseño: se lee con standard_missing_pairs y standard_doubtful_pairs.'`);
  await knex.raw(`COMMENT ON COLUMN ${COV}.erp_value_known IS 'EX.H0 — suma de unidades × erp_unit_cost de los pares que SÍ tienen costo del ERP. Parcial por diseño: se lee con erp_missing_pairs.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE ${SNAP} DROP CONSTRAINT IF EXISTS stocksnap_standard_rule_valida`);
  for (const col of ['erp_unit_cost', 'standard_unit_cost', 'standard_cost_rule']) {
    await knex.raw(`ALTER TABLE ${SNAP} DROP COLUMN IF EXISTS ${col}`);
  }
  for (const col of ['stock_source', 'erp_value_known', 'erp_missing_pairs', 'standard_value_known',
    'standard_missing_pairs', 'standard_doubtful_pairs']) {
    await knex.raw(`ALTER TABLE ${COV} DROP COLUMN IF EXISTS ${col}`);
  }
  // El NOT NULL vuelve sólo si ninguna foto posterior escribió NULL: rellenar esas filas sería
  // inventar los apartados que la fuente no trae, y tocaría filas que el `up` no escribió.
  const nulos = await knex.raw(
    `SELECT count(*) FILTER (WHERE reservadas IS NULL)::int r, count(*) FILTER (WHERE disponibles IS NULL)::int d FROM ${SNAP}`,
  );
  const { r, d } = nulos.rows[0];
  if (r === 0) await knex.raw(`ALTER TABLE ${SNAP} ALTER COLUMN reservadas SET NOT NULL`);
  if (d === 0) await knex.raw(`ALTER TABLE ${SNAP} ALTER COLUMN disponibles SET NOT NULL`);
  if (r || d) console.log(`  [EX.H0] down: ${r} reservadas / ${d} disponibles en NULL — se dejan nullable`);
};
