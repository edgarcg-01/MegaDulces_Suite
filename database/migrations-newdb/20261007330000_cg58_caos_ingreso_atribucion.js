/**
 * `[CG.58]` — **Dónde vive la atribución «este depósito de CAOS lo explican estos cobros».**
 *
 * ── Por qué hace falta una tabla nueva y no alcanza la que ya está ───────────────────────────
 *
 * `finance.caos_cash_links` tiene
 *
 *     UNIQUE (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL
 *
 * o sea **un enlace vivo por movimiento de CAOS**. Modela *un movimiento de CAOS ↔ una captura de
 * caja*, con monto parcial. Es correcto para lo que fue hecha (CS.3: qué retiro pagó este gasto) y
 * **no sirve acá**: un ingreso a la caja fuerte lo explican **N cobros de Kepler**, y meterlos en
 * esa tabla los haría colisionar contra su propio candado anti-doble-conteo.
 *
 * ── ⛔ Por qué TABLA y no vista derivada ─────────────────────────────────────────────────────
 *
 * El reparto es determinista (`caja-caos-ingreso.engine`: FIFO sobre cobros anteriores), así que
 * técnicamente se podría derivar con una vista y no guardar nada — que es la regla de la casa para
 * casi todo lo demás.
 *
 * Acá **no**, y la razón es la misma por la que `[CG.15]` NO guarda el saldo pero sí guarda el
 * corte: una atribución derivada **cambia el pasado**. Llega un cobro viejo por el feed, o alguien
 * cancela uno en Kepler, y el reparto de hace tres meses se re-dibuja solo — con otros tramos, en
 * otros depósitos, sin que nadie se entere. Una asignación de efectivo que se mueve sola no se
 * puede auditar ni firmar, y es exactamente lo que `[CG.15]` dice del `SaldoD` del Access.
 *
 * Se **materializa el reparto** y se **conserva el método** (`metodo`, `calculado_en`): quien lo
 * lea sabe con qué regla se hizo, y volver a correrlo no pisa lo que ya se cerró.
 *
 * ── Lo que esta tabla NO es ─────────────────────────────────────────────────────────────────
 *
 * No es una copia de los cobros ni de los depósitos: guarda **la unión** (qué tramo de qué cobro
 * entró a qué depósito) y nada más. El cobro vive en `kepler_ods` y se lee por
 * `finance.v_caja_movimientos_pendientes`; el depósito vive en `analytics.caos_cash_movements`.
 *
 * ── El candado que importa ──────────────────────────────────────────────────────────────────
 *
 * ⭐ **Un cobro no se puede atribuir dos veces.** Sin eso el 100% sería de mentira: alcanzaría con
 * reusar el mismo cobro hasta cubrir todo. El índice `ux_caos_atrib_cobro_vivo` lo impide **en la
 * base**, no en el servicio — es el mismo criterio que la doble llave de `[CG.15]`.
 *
 * ⚠️ Es parcial por `deleted_at IS NULL`: recalcular un período se hace borrando (lógico) su
 * reparto y volviéndolo a escribir, no actualizando filas vivas.
 *
 * ⚠️ `COMMENT ON` **no admite parámetros** — `knex.raw('COMMENT ON … IS ?', [t])` lo manda como
 * `$1` y Postgres lo rechaza con `syntax error at or near "$1"`. Esta sesión ya se comió ese bug
 * en dos migraciones. Va interpolado con el texto escapado.
 *
 * Idempotente. Aditiva. RLS FORZADO + grants.
 *
 * @param { import("knex").Knex } knex
 */

/** Escapa un literal para `COMMENT ON`, que no acepta binds. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('caos_ingreso_atribucion'))) {
    await knex.raw(`
      CREATE TABLE finance.caos_ingreso_atribucion (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,

        -- el DEPÓSITO que se explica (analytics.caos_cash_movements, type_id = 0)
        caos_device       text   NOT NULL,
        caos_external_id  bigint NOT NULL,
        caos_occurred_at  timestamptz NOT NULL,

        -- el COBRO de Kepler que lo respalda (finance.v_caja_movimientos_pendientes)
        cobro_origen_ref  text NOT NULL,
        cobro_fecha       date NOT NULL,

        -- cuánto de ESE cobro entró a ESTE depósito. Parcial a propósito: los depósitos son
        -- múltiplos de 10 y el 57% de los cobros traen centavos, así que el último tramo de
        -- cada depósito casi siempre lo es.
        monto             numeric(18,2) NOT NULL CHECK (monto > 0),

        -- con qué regla se repartió, para que el número se pueda defender después
        metodo            text NOT NULL DEFAULT 'fifo_anterior',
        calculado_en      timestamptz NOT NULL DEFAULT now(),
        calculado_por     uuid,

        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        deleted_at        timestamptz,

        -- ⭐ LA LEY DEL PROCESO, en la base y no en el servicio: el cobro va ANTES que el
        -- depósito. Medido sobre 708 depósitos y 2,548 eventos: se cumple en el 100% de los
        -- casos. Un reparto que la viole no es un reparto: es un respaldo inventado.
        CONSTRAINT caos_atrib_orden_chk CHECK (cobro_fecha <= caos_occurred_at::date),
        CONSTRAINT caos_atrib_metodo_chk CHECK (metodo IN ('fifo_anterior','manual'))
      )`);

    // ⭐ Un COBRO no se atribuye dos veces. Sin esto el 100% sería de mentira: bastaría con
    // reusar el mismo cobro hasta cubrir todo.
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_atrib_cobro_vivo
      ON finance.caos_ingreso_atribucion (tenant_id, cobro_origen_ref) WHERE deleted_at IS NULL`);
    // Un depósito SÍ lleva varias filas (es N:1), pero no la misma pareja dos veces.
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_atrib_par_vivo
      ON finance.caos_ingreso_atribucion (tenant_id, caos_device, caos_external_id, cobro_origen_ref)
      WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_caos_atrib_deposito
      ON finance.caos_ingreso_atribucion (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_caos_atrib_fecha
      ON finance.caos_ingreso_atribucion (tenant_id, caos_occurred_at DESC) WHERE deleted_at IS NULL`);

    await tenantRls(knex, 'caos_ingreso_atribucion');
  }

  await knex.raw(`COMMENT ON TABLE finance.caos_ingreso_atribucion IS ${lit(
    '[CG.58] Qué cobros de Kepler explican cada ingreso a la caja fuerte (CAOS). N cobros por '
    + 'depósito: el 1:1 por importe es imposible (los depósitos son múltiplos de 10 y el 57% de '
    + 'los cobros traen centavos; sólo 3.5% casaría exacto). Se MATERIALIZA el reparto en vez de '
    + 'derivarlo, porque una atribución de efectivo que se recalcula sola cambia el pasado cada '
    + 'vez que llega un cobro nuevo. ux_caos_atrib_cobro_vivo impide usar un cobro dos veces.',
  )}`);
  await knex.raw(`COMMENT ON COLUMN finance.caos_ingreso_atribucion.monto IS ${lit(
    'Cuánto de ESE cobro entró a ESTE depósito. Parcial a propósito: el último tramo de cada '
    + 'depósito casi siempre lo es.',
  )}`);
  await knex.raw(`COMMENT ON CONSTRAINT caos_atrib_orden_chk ON finance.caos_ingreso_atribucion IS ${lit(
    'La ley del proceso: el cobro se registra en Kepler ANTES de que el efectivo entre al equipo. '
    + 'Medido sobre 708 depósitos y 2,548 eventos (2026-10-07): se cumple en el 100% de los casos, '
    + 'el saldo corrido nunca se va a negativo (peor momento +$7,776.41).',
  )}`);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS finance.caos_ingreso_atribucion');
};
