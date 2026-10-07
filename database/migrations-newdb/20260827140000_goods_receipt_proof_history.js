'use strict';
/**
 * `[RE.13.2]` — Historial de decisiones + motivo TIPIFICADO de la evidencia de recepción.
 *
 * Dos huecos que la bandeja de revisión no puede tener:
 *
 * 1. **Sin historial.** `goods_receipt_proofs` guarda `status` + `validated_by` +
 *    `validated_at` y los SOBREESCRIBE: un `recibido → rechazado → validado` no deja
 *    rastro de que hubo una ida y vuelta, y `reject` reusa `validated_by` para decir
 *    "quién rechazó" (o sea la columna miente sobre lo que es). Un expediente que
 *    justifica un pago necesita la cadena completa, no el último estado.
 *    Patrón copiado de `commercial.order_status_history` (Fase D.1).
 *
 * 2. **Motivo libre.** `motivo_rechazo` es texto: no se puede contestar "¿por qué se
 *    devuelve el 30% de lo que sube la sucursal 01?". `motivo_codigo` agrega el catálogo
 *    (el texto libre queda para el detalle, que sigue siendo útil).
 *
 * Aditiva e idempotente. No toca datos existentes: el historial arranca vacío y se llena
 * desde el próximo `attach`/`validate`/`reject` (no se inventa el pasado — hoy la tabla de
 * evidencias está vacía, así que no hay pasado que inventar).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // ── 1. Motivo tipificado ──────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasColumn('goods_receipt_proofs', 'motivo_codigo'))) {
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs ADD COLUMN motivo_codigo text`);
    await knex.raw(`COMMENT ON COLUMN finance.goods_receipt_proofs.motivo_codigo IS
      'RE.13.2 — motivo de rechazo del catálogo (ilegible|no_corresponde|total_no_cuadra|falta_hoja|duplicada|otro). El texto libre sigue en motivo_rechazo.'`);
  }
  // Sin CHECK a propósito: el catálogo va a crecer y una migración por motivo nuevo es
  // fricción sin beneficio (el service valida contra la lista).
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_grp_motivo ON finance.goods_receipt_proofs (motivo_codigo)
    WHERE motivo_codigo IS NOT NULL`);

  // ── 2. Historial de decisiones ────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('goods_receipt_proof_history'))) {
    await knex.raw(`
      CREATE TABLE finance.goods_receipt_proof_history (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        proof_id      uuid NOT NULL,
        -- Denormalizados para poder leer el historial de una entrada sin JOIN (y para que
        -- sobreviva si la evidencia se borra): es el patrón de order_status_history.
        sucursal      text NOT NULL,
        folio         text NOT NULL,
        status_from   text,
        status_to     text NOT NULL,
        motivo_codigo text,
        motivo        text,
        changed_by    text,
        changed_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      )`);
    await knex.raw(`ALTER TABLE finance.goods_receipt_proof_history ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.goods_receipt_proof_history FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON finance.goods_receipt_proof_history
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auto_populate_tenant_id') THEN
          DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON finance.goods_receipt_proof_history;
          CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON finance.goods_receipt_proof_history
            FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
        END IF;
      END $$;`);
    await knex.raw(`CREATE INDEX ix_fin_grph_proof ON finance.goods_receipt_proof_history (tenant_id, proof_id, changed_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_grph_entrada ON finance.goods_receipt_proof_history (tenant_id, sucursal, folio, changed_at DESC)`);
    // Solo INSERT + SELECT: un historial que se puede editar no es historial.
    await knex.raw(`GRANT SELECT, INSERT ON finance.goods_receipt_proof_history TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE finance.goods_receipt_proof_history IS
      'RE.13.2 — cadena de decisiones de la evidencia de recepción (quién subió, quién validó/rechazó, cuándo y por qué). Append-only: app_runtime no tiene UPDATE ni DELETE.'`);
  }
};

exports.down = async function down(knex) {
  // El historial no se borra al bajar la fase: es evidencia de decisiones reales.
  await knex.raw(`SELECT 1`);
};
