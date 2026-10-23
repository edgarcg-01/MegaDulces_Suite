'use strict';
/**
 * `[CG.199]` — **El pedido de firma por teléfono es una FILA, no un recuerdo del socket.**
 *
 * Edgar, 2026-10-23: *«a veces tienen que firmar hasta 3 veces… que este sistema no falle por
 * nada del mundo»*. Hasta hoy el emparejamiento PC ↔ teléfono vivía en `client.data` del socket de
 * la PC, y la firma viajaba por un `emit` sin acuse. Todo lo que corta un socket —un despliegue,
 * el wifi, una pestaña en segundo plano— perdía el pedido o la firma, en silencio.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-23) ────────────────────────────────────────
 *  · Movimientos que requieren firma: firmados 33 % (12–16 oct) → 5.8 % (17–23 oct, 9 de 155;
 *    $1,795,635.51 sin firma).
 *  · 11 rollouts del `api` del 20 al 23-oct, casi todos en horario hábil: cada uno cortaba todos
 *    los sockets donde vivía el pedido.
 *  · Tasa de falla del canal: NO MEDIDA — el pedido no dejaba ningún rastro. Esta tabla es el
 *    rastro: pedidos, tomados, firmados, usados y el último fallo salen de un SELECT.
 *
 * ── Qué guarda ──────────────────────────────────────────────────────────────────────────────
 *  · `contexto`: los MISMOS cuatro campos que ya se le mostraban al teléfono (tipo, monto,
 *    beneficiario, documento). Nada más: el teléfono se le presta a quien firma.
 *  · `monto` aparte y tipado: al guardar el movimiento se compara al centavo
 *    (`firmaSigueValiendo`). Una firma sobre otra cifra no vale.
 *  · `telefono_id`: el teléfono que la tomó. Re-tomarla desde EL MISMO (bloqueo de pantalla,
 *    recarga) no es un segundo uso; desde otro, sí se rechaza.
 *  · `usada_en`: el movimiento que la consumió. Una firma se usa una sola vez.
 *
 * ⛔ El token del QR NO se guarda: es un JWT firmado por el servidor que lleva el id; la autoridad
 *    es esta fila (estado y `expira_at`), que se relee en cada uso — el molde de
 *    `finance.expense_capture_links` (`[GX.9]`).
 *
 * Dato propio (HITL), no del ODS: tabla legítima. Aditiva, sin tocar `cash_ledger`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable('cash_signature_requests'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_signature_requests (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        tipo                 text NOT NULL,
        monto                numeric(18,2) NOT NULL,
        contexto             jsonb NOT NULL,
        estado               text NOT NULL DEFAULT 'abierta',
        expira_at            timestamptz NOT NULL,
        telefono_id          text,
        tomada_at            timestamptz,
        firma_png            text,
        firma_nombre         text,
        firmada_at           timestamptz,
        usada_en             uuid,
        usada_at             timestamptz,
        cancelada_at         timestamptz,
        intentos_envio       integer NOT NULL DEFAULT 0,
        ultimo_fallo         text,
        created_by           uuid NOT NULL,
        created_by_username  text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cash_sig_req_estado_chk CHECK (estado IN ('abierta','tomada','firmada','usada','cancelada')),
        CONSTRAINT cash_sig_req_monto_chk CHECK (monto >= 0),
        CONSTRAINT cash_sig_req_contexto_chk CHECK (jsonb_typeof(contexto) = 'object'),
        -- Lo firmado trae su imagen y su hora; lo usado, además, el movimiento. Sin esto un
        -- UPDATE descuidado podría dejar «firmada» sin firma, que es lo que esta tabla evita.
        CONSTRAINT cash_sig_req_firmada_chk CHECK (
          estado NOT IN ('firmada','usada') OR (firma_png IS NOT NULL AND firmada_at IS NOT NULL)),
        CONSTRAINT cash_sig_req_usada_chk CHECK (
          (estado = 'usada') = (usada_en IS NOT NULL AND usada_at IS NOT NULL)),
        CONSTRAINT cash_sig_req_tomada_chk CHECK (
          estado NOT IN ('tomada','firmada','usada') OR telefono_id IS NOT NULL)
      )`);
    await knex.raw(`CREATE INDEX ix_cash_sig_req_tenant_created ON finance.cash_signature_requests (tenant_id, created_at DESC)`);
    // Un movimiento consume UNA firma, y una firma se consume UNA vez.
    await knex.raw(`CREATE UNIQUE INDEX ux_cash_sig_req_usada_en ON finance.cash_signature_requests (usada_en) WHERE usada_en IS NOT NULL`);
  }

  await knex.raw(`ALTER TABLE finance.cash_signature_requests ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.cash_signature_requests FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='cash_signature_requests' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.cash_signature_requests
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Sin DELETE: un pedido no se borra, se cancela. El rastro es lo que mide si el canal falla.
  await knex.raw(`REVOKE DELETE ON finance.cash_signature_requests FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.cash_signature_requests TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE finance.cash_signature_requests IS
    '[CG.199] Pedido de firma de un movimiento de caja desde el telefono (QR). La autoridad del QR es esta fila: estado + expira_at, releidos en cada uso. abierta -> tomada -> firmada -> usada; o cancelada. Vencida se calcula (expira_at), no se guarda.'`);
};

/** Deshace sólo si está vacía: con pedidos guardados, borrarla tira la constancia de quién firmó. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable('cash_signature_requests'))) return;
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.cash_signature_requests`);
  if (rows[0].n > 0) {
    throw new Error(`[CG.199] down rechazado: finance.cash_signature_requests tiene ${rows[0].n} pedidos de firma.`);
  }
  await knex.raw(`DROP TABLE finance.cash_signature_requests`);
};
