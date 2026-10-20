'use strict';
/**
 * `[CGA-A.37]` — El candado de la atribución de CAOS prohibía el reparto que la tabla existe para
 * guardar. Se reemplaza por la invariante que de verdad protege: **lo atribuido a un cobro nunca
 * pasa de su monto.**
 *
 * ── Lo medido antes (sólo lectura, 2026-10-20) ──────────────────────────────────────────────
 *  · `finance.caos_ingreso_atribucion`: **0 filas en toda su vida**. El carril
 *    `caos_ingreso_conciliar` falla en CADA corrida (latido `error`, mensaje truncado).
 *  · Reproduciendo `conciliar()` con el motor real y los datos de prod: **1,667 tramos**, de los
 *    que **779** repiten el `cobro_origen_ref` de otro — **512 cobros partidos entre dos
 *    depósitos** (p. ej. `00|U-A-5|0014589|0011`: $29,590.37 al #451 y $2,333.27 al #452). El
 *    índice único `ux_caos_atrib_cobro_vivo (tenant_id, cobro_origen_ref)` los rechaza, el primer
 *    lote de 500 ya trae uno, y la transacción entera se revierte. Las otras tres restricciones
 *    (`par_vivo`, `orden_chk`, `monto > 0`): **0** violaciones.
 *  · La invariante nueva, sobre el mismo reparto: **888 cobros usados, 0 exceden su monto**; la
 *    fuente no repite `origen_ref`. Control: duplicar un tramo SÍ la viola.
 *
 * ── Por qué el índice estaba mal, y no el motor ─────────────────────────────────────────────
 * La migración que lo creó (`20261007330000`) comenta la columna `monto` como *«parcial a
 * propósito: el último tramo de cada depósito casi siempre lo es»*. Un tramo parcial deja un resto
 * del cobro que va al depósito siguiente: el MISMO cobro en dos filas es el diseño. El candado
 * quería decir *«un cobro no se usa dos veces»* y lo escribió como *«un cobro aparece en una sola
 * fila»*, que es otra cosa.
 *
 * ── Por qué el candado nuevo NO lee la vista de cobros ──────────────────────────────────────
 * `finance.v_caja_movimientos_pendientes` filtra por `current_setting('app.tenant_id')` y un cobro
 * SALE de ella en cuanto se captura en el libro. Un trigger que la consultara fallaría por
 * contexto, no por dinero. Por eso cada fila guarda el monto TOTAL de su cobro (`cobro_monto`) y
 * el trigger compara contra la propia tabla.
 *
 * ── Lo que queda protegido ──────────────────────────────────────────────────────────────────
 *  1. `monto <= cobro_monto` en cada fila (CHECK).
 *  2. Σ monto vivo por cobro ≤ su `cobro_monto` (trigger por sentencia).
 *  3. Todas las filas vivas de un cobro dicen el MISMO `cobro_monto` (si no, el 2 se esquiva).
 *  4. La misma pareja depósito+cobro no se repite (`ux_caos_atrib_par_vivo`, se conserva).
 *
 * Idempotente. ⚠️ `cobro_monto` nace NOT NULL sólo si la tabla está vacía (en prod lo está); si no,
 * nace nullable y la migración lo dice — inventarle el monto a una fila vieja sería un default
 * disfrazado (ADR-056).
 *
 * @param { import("knex").Knex } knex
 */

const FN = 'finance.caos_atrib_cobro_no_excede';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasColumn('caos_ingreso_atribucion', 'cobro_monto'))) {
    await knex.raw(`ALTER TABLE finance.caos_ingreso_atribucion ADD COLUMN cobro_monto numeric(18,2)`);
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.caos_ingreso_atribucion`);
    if (rows[0].n === 0) {
      await knex.raw(`ALTER TABLE finance.caos_ingreso_atribucion ALTER COLUMN cobro_monto SET NOT NULL`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[CGA-A.37] caos_ingreso_atribucion tiene ${rows[0].n} filas: cobro_monto queda NULLABLE (no se inventa).`);
    }
    await knex.raw(`ALTER TABLE finance.caos_ingreso_atribucion
      ADD CONSTRAINT caos_atrib_tramo_cabe_chk CHECK (cobro_monto IS NULL OR monto <= cobro_monto + 0.005)`);
  }

  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE malo record;
    BEGIN
      SELECT a.tenant_id, a.cobro_origen_ref,
             sum(a.monto) AS usado, max(a.cobro_monto) AS monto_cobro,
             count(DISTINCT a.cobro_monto) AS montos_distintos
        INTO malo
        FROM finance.caos_ingreso_atribucion a
        JOIN (SELECT DISTINCT tenant_id, cobro_origen_ref FROM nuevos) n
          ON n.tenant_id = a.tenant_id AND n.cobro_origen_ref = a.cobro_origen_ref
       WHERE a.deleted_at IS NULL
       GROUP BY a.tenant_id, a.cobro_origen_ref
      HAVING count(DISTINCT a.cobro_monto) > 1
          OR (max(a.cobro_monto) IS NOT NULL AND sum(a.monto) > max(a.cobro_monto) + 0.005)
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'caos_atrib_cobro_excedido: el cobro % lleva % atribuidos contra un monto de % (% montos distintos declarados)',
          malo.cobro_origen_ref, malo.usado, malo.monto_cobro, malo.montos_distintos
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END $$`);

  // Postgres no admite tablas de transición en un trigger de varios eventos: van dos.
  await knex.raw(`DROP TRIGGER IF EXISTS caos_atrib_cobro_no_excede_ins ON finance.caos_ingreso_atribucion`);
  await knex.raw(`CREATE TRIGGER caos_atrib_cobro_no_excede_ins
    AFTER INSERT ON finance.caos_ingreso_atribucion
    REFERENCING NEW TABLE AS nuevos FOR EACH STATEMENT EXECUTE FUNCTION ${FN}()`);
  await knex.raw(`DROP TRIGGER IF EXISTS caos_atrib_cobro_no_excede_upd ON finance.caos_ingreso_atribucion`);
  await knex.raw(`CREATE TRIGGER caos_atrib_cobro_no_excede_upd
    AFTER UPDATE ON finance.caos_ingreso_atribucion
    REFERENCING NEW TABLE AS nuevos FOR EACH STATEMENT EXECUTE FUNCTION ${FN}()`);

  // Recién ahora, con el candado correcto puesto, se quita el que contradecía al diseño.
  await knex.raw(`DROP INDEX IF EXISTS finance.ux_caos_atrib_cobro_vivo`);

  await knex.raw(`COMMENT ON COLUMN finance.caos_ingreso_atribucion.cobro_monto IS
    'Monto TOTAL del cobro de Kepler (no del tramo). Lo usa el trigger caos_atrib_cobro_no_excede: lo atribuido a un cobro, sumando sus tramos vivos, nunca pasa de aca. [CGA-A.37]'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS caos_atrib_cobro_no_excede_ins ON finance.caos_ingreso_atribucion`);
  await knex.raw(`DROP TRIGGER IF EXISTS caos_atrib_cobro_no_excede_upd ON finance.caos_ingreso_atribucion`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN}()`);
  await knex.raw(`ALTER TABLE finance.caos_ingreso_atribucion DROP CONSTRAINT IF EXISTS caos_atrib_tramo_cabe_chk`);
  await knex.raw(`ALTER TABLE finance.caos_ingreso_atribucion DROP COLUMN IF EXISTS cobro_monto`);
  // ⚠️ Recrear el índice viejo falla si ya hay cobros partidos escritos — que es justo el defecto.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_caos_atrib_cobro_vivo
    ON finance.caos_ingreso_atribucion (tenant_id, cobro_origen_ref) WHERE deleted_at IS NULL`);
};
