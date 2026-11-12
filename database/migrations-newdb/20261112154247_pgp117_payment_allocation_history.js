'use strict';
/**
 * `[PGP.117]` — **La bitácora de los pagos del Calendario.** Edgar, 2026-11-12: «después de una semana
 * hay que quitar lo que no se haya pagado, pero dejar logs de lo ocurrido».
 *
 * Un pago pendiente APARTA el saldo de sus facturas: mientras siga `pending`, esas facturas no se
 * ofrecen para programar. Si su día pasó y nadie lo pagó, las facturas quedan escondidas para
 * siempre. `[PGP.117]` lo libera a la semana (`status = 'cancelled'`), y esta tabla guarda QUÉ se
 * liberó, POR QUÉ (lo que dijeron Kepler y el banco) y QUIÉN: el pago y sus renglones no se borran,
 * pero su estado sí cambia, y la evidencia del momento sólo queda aquí.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-12) ────────────────────────────────────────
 *  · 196 pagos `pending` ($42.4 M) y **ninguno** `executed`: el cierre lo hace Kepler, no la Suite.
 *  · 76 con su día hace 7 días o más ($14.9 M): 54 ya saldados en Kepler, 9 a medias, 6 sin
 *    testigo de Kepler (no son facturas del ERP) y 7 sin ningún abono en Kepler.
 *  · De esos 7, 2 tienen una salida de banco por el mismo importe (placebo +$100: 0 de 76) → se
 *    conservan. Se liberarían **5 ($354,346.17)** — el ensayo en seco con el código real dice lo mismo.
 *
 * Append-only: `app_runtime` tiene SELECT e INSERT, sin UPDATE ni DELETE (un historial que se puede
 * editar no es historial). Mismo patrón que `finance.goods_receipt_proof_history`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('finance').hasTable('payment_allocation_history')) return;
  await knex.raw(`
    CREATE TABLE finance.payment_allocation_history (
      id            uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid NOT NULL,
      -- Sin FK a propósito: la bitácora sobrevive aunque el pago se borre algún día.
      allocation_id uuid NOT NULL,
      -- 'liberado_por_vencimiento' hoy; el catálogo crece sin migración (lo valida el servicio).
      event         text NOT NULL,
      status_from   text,
      status_to     text,
      -- Lo que había y lo que se midió en ese momento: día, importe, renglones, Kepler, banco.
      detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by    text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
  await knex.raw(`ALTER TABLE finance.payment_allocation_history ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.payment_allocation_history FORCE ROW LEVEL SECURITY`);
  await knex.raw(`CREATE POLICY tenant_isolation ON finance.payment_allocation_history
    USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auto_populate_tenant_id') THEN
        DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON finance.payment_allocation_history;
        CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON finance.payment_allocation_history
          FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
      END IF;
    END $$;`);
  await knex.raw(`CREATE INDEX ix_fin_pah_allocation ON finance.payment_allocation_history (tenant_id, allocation_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX ix_fin_pah_event ON finance.payment_allocation_history (tenant_id, event, created_at DESC)`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT ON finance.payment_allocation_history TO app_runtime;
      END IF;
    END $$;`);
  await knex.raw(`COMMENT ON TABLE finance.payment_allocation_history IS
    'PGP.117 — bitácora de los pagos del Calendario: qué se liberó, por qué (Kepler y banco al momento) y quién. Append-only: app_runtime no tiene UPDATE ni DELETE.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  // La bitácora no se borra al bajar: es evidencia de lo que pasó con pagos reales.
  await knex.raw(`SELECT 1`);
};
