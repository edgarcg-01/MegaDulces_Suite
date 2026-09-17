/**
 * Fase SU.4 — EL HECHO DEL SURTIDO: qué se levantó de verdad (ADR-067).
 *
 * `commercial.wave_lines` — un renglón por SKU de la ola, con lo pedido y **lo que la persona
 * realmente levantó del anaquel**.
 *
 * ⭐ Por qué ESTO sí se materializa, si el consolidado es derivado: el consolidado (cuánto pide
 * la ola) se deriva de `order_lines` y se recalcula solo. **Lo levantado no se deriva de nada** —
 * es un hecho que ocurre en el almacén y que nadie más registra. Materializar lo derivable sería
 * una segunda verdad; materializar un hecho propio es la única forma de tenerlo.
 *
 * ⚠️ `qty_requested` se congela al ARRANCAR el surtido, no al crear la ola. Si se congelara antes,
 * un pedido corregido entre armar y empezar dejaría a la persona buscando una cantidad que ya
 * nadie pidió. Y no se recalcula después: a media ola, el papel que la persona está recorriendo
 * no puede cambiarle debajo.
 *
 * ⛔ NO hay columna de reserva ni de apartado (decisión de Edgar 2026-09-17): el sistema no aparta.
 * El reparto de lo escaso se resuelve sobre `qty_picked`, o sea sobre lo que hubo.
 *
 * ── Las excepciones del §14/§16 del documento origen ──────────────────────────────────────────
 * `status` distingue lo que el documento mezclaba: **faltante** (había menos de lo pedido) de
 * **agotado** (no había nada) de **dañado** (había, pero no se puede vender). Son tres decisiones
 * comerciales distintas —surtir parcial, buscar sustituto, dar de baja— y colapsarlas en "no hay"
 * obliga a alguien a volver a preguntar.
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('wave_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.wave_lines (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL DEFAULT public.current_tenant_id(),
        wave_id        uuid NOT NULL REFERENCES commercial.picking_waves(id) ON DELETE CASCADE,
        product_id     uuid NOT NULL,
        -- Lo que la ola pide, congelado al arrancar. En unidad BASE.
        qty_requested  numeric(14,3) NOT NULL CHECK (qty_requested > 0),
        -- ⭐ La unidad se congela CON la cantidad. Un número sin su unidad no es un dato
        -- (ADR-055/057): NULL = las líneas venían en unidades distintas o sin declarar, y
        -- entonces la pantalla habla en unidad base y lo dice. NUNCA se rellena con 'PZA'.
        qty_unit       varchar(16),
        unidad_mixta   boolean NOT NULL DEFAULT false,
        -- Lo que la persona levantó. NULL = todavía no pasó por este renglón; 0 con status
        -- 'agotado' = pasó y no había. Los dos son distintos y se distinguen a propósito.
        qty_picked     numeric(14,3) CHECK (qty_picked IS NULL OR qty_picked >= 0),
        status         varchar(16) NOT NULL DEFAULT 'pendiente'
                       CHECK (status IN ('pendiente','surtido','faltante','agotado','danado')),
        bin_code       varchar(40),
        note           text,
        picked_by      uuid,
        picked_at      timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wave_id, product_id)
      )`);
    await knex.raw(`CREATE INDEX ix_wl_wave ON commercial.wave_lines (tenant_id, wave_id, status)`);
    await tenantRls(knex, 'commercial', 'wave_lines');
    await knex.raw(`COMMENT ON TABLE commercial.wave_lines IS
      'SU.4 - Lo que la ola pide y lo que la persona LEVANTO. Lo pedido se congela al arrancar el surtido; lo levantado es un hecho que no se deriva de ninguna otra tabla.'`);
    await knex.raw(`COMMENT ON COLUMN commercial.wave_lines.qty_picked IS
      'SU.4 - NULL = no se paso por el renglon todavia. 0 con status agotado = se paso y no habia. Son distintos.'`);
    await knex.raw(`COMMENT ON COLUMN commercial.wave_lines.qty_unit IS
      'SU.4 - La unidad en la que se cuenta este renglon. NULL = mixta o sin declarar -> se cuenta en base y la pantalla lo dice. NUNCA se rellena por default (ADR-056).'`);
  }

  // ── Quién surtió y quién verificó, por separado ─────────────────────────────────────────
  // ⚠️ Edgar decidió que una sola persona hace todo el flujo, así que el §21 del documento
  // ("evitar que el surtidor se auto-chequee") NO se implementa como bloqueo: bloquearlo dejaría
  // el almacén sin poder cerrar una ola. Pero las dos columnas se guardan SEPARADAS igual, por
  // dos razones: (1) el día que haya dos personas el gate se enciende sin migrar nada; (2) así se
  // puede MEDIR en qué porcentaje de las olas fueron la misma persona — un dato consultable vale
  // más que un control apagado que nadie recuerda que está apagado.
  if (!(await knex.schema.withSchema('commercial').hasColumn('picking_waves', 'picked_by'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves ADD COLUMN picked_by uuid`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('picking_waves', 'verified_by'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves ADD COLUMN verified_by uuid`);
    await knex.raw(`COMMENT ON COLUMN commercial.picking_waves.verified_by IS
      'SU.4 - Quien re-verifico. Puede ser la MISMA persona que picked_by (decision 2026-09-17: una sola persona). Se guarda aparte para poder medirlo y para encender el gate si algun dia son dos.'`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.wave_lines`);
  await knex.raw(`ALTER TABLE commercial.picking_waves DROP COLUMN IF EXISTS picked_by`);
  await knex.raw(`ALTER TABLE commercial.picking_waves DROP COLUMN IF EXISTS verified_by`);
};
