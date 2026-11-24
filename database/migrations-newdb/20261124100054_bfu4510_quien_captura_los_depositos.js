'use strict';
/**
 * `[BFU.4.5.10]` — **Quién responde por los depósitos de cada CUENTA se DERIVA de Kepler**, no se configura a mano
 * (anexo BFU, BFU.4.5; investigación `FASE_CB_ANEXO_BFU_INVESTIGACION_AREAS.md`, P6 y P13).
 *
 * Un depósito sin documento lo resuelve quien captura en Kepler los depósitos de ESA cuenta: la venta de la sucursal
 * (`U-A-5`) o el cobro a un cliente (`U-A-7`). Esa persona ya está en el ODS (`kdm1.c67`, el usuario que capturó) y la
 * cuenta ya está en la conciliación (`bank_recon_matches` → `bank_movements.bank_account_id`).
 *
 *  · `analytics.v_kepler_deposit_capturers` (vista, derive-no-copy, `security_invoker`): por cuenta de banco, quién
 *    capturó los documentos de los depósitos que casaron en los últimos 30 días, cuántos, de qué tipo, de qué
 *    sucursales, su parte y su lugar. Fresca sin mantenimiento.
 *  · `identity.user_kepler_logins` (dato propio): el par «usuario de Kepler → usuario de la Suite». Es la única
 *    pregunta que el ODS no contesta; nace VACÍA y se llena como parámetro (Edgar / Sistemas). Un usuario de la Suite
 *    puede tener varios logins de Kepler; un login, un solo usuario vivo.
 *
 * ── Por qué por CUENTA y no por sucursal (sólo lectura, pg-prod 7688376744939610156, 2026-11-24) ─────────────
 * Un depósito sin documento no dice de qué sucursal es, y las dos llaves que parecían decirlo no alcanzan:
 *  · `bank_movements.sucursal` NO es la sucursal de Kepler: es la sucursal BANCARIA (90, 75, 10…), y viene vacía en
 *    352 de los 565 depósitos «cobranza» de noviembre. Donde viene y es firme acierta 96 % (placebo 5 %), pero cubre
 *    el 12 % de los depósitos casados.
 *  · La cuenta NO dice la sucursal: varias sucursales depositan en la misma cuenta (acierto 29 %, placebo 12 %).
 *  · La cuenta SÍ dice quién captura: entrenado con los depósitos casados de los 30 días anteriores al 1-nov y probado
 *    con los 1,526 de noviembre, el primer lugar acierta 75 % y los dos primeros 90 %; el placebo (el primero de otra
 *    cuenta, al azar) 23 %. Con 60 días de historia, 72 / 90 / 22: se queda en 30 (sigue los relevos de personal).
 *  · La vista: 52 filas, 15 cuentas, 12 logins, 2,110 depósitos; 112 ms (EXPLAIN ANALYZE).
 *  · ⚠️ Lo aprendido sale de los depósitos que SÍ casaron; los que no casan pueden ser de otra mezcla (cortes de
 *    terminal). Se declara: el CI no lo mide, lo mide el primer mes de uso (cuántos pendientes reasigna la persona).
 *  · ⚠️ Kepler sobrescribe `c67` al cancelar: un documento cancelado diría quién lo canceló. En 30 días pesa poco.
 *  · El primero que más capturó no siempre es el de hoy (en Zamora Centro dejó de capturar el 13-nov): por eso
 *    `capturo_esta_semana`; quien consuma la vista no manda el pendiente a quien ya no captura.
 *
 * Aditiva e idempotente: una tabla nueva vacía y una vista nueva; la API desplegada no las lee.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
  CREATE VIEW analytics.v_kepler_deposit_capturers WITH (security_invoker = true) AS
  WITH dep AS (
    -- Un depósito casado con varios documentos cuenta UNA vez: el de mayor importe.
    SELECT DISTINCT ON (bm.id) bm.id, bm.tenant_id, bm.bank_account_id, r.kepler_sucursal, r.kepler_doc_tipo, r.kepler_doc_folio
      FROM finance.bank_movements bm
      JOIN finance.bank_recon_matches r ON r.bank_movement_id = bm.id
     WHERE bm.amount_in > 0 AND bm.deleted_at IS NULL
       AND bm.movement_date >= current_date - 30
       AND r.kepler_doc_tipo IN ('U-A-5', 'U-A-7')
     ORDER BY bm.id, r.kepler_amount DESC NULLS LAST, r.kepler_doc_folio
  ), cap AS (
    SELECT d.tenant_id, d.bank_account_id, upper(btrim(k.c67)) AS kepler_login,
           count(*)::int AS depositos,
           count(*) FILTER (WHERE d.kepler_doc_tipo = 'U-A-5')::int AS de_venta_sucursal,
           count(*) FILTER (WHERE d.kepler_doc_tipo = 'U-A-7')::int AS de_cobro_cliente,
           array_agg(DISTINCT d.kepler_sucursal ORDER BY d.kepler_sucursal) AS sucursales,
           max(l.fecha_captura) AS ultima_captura
      FROM dep d
      JOIN LATERAL (
        SELECT l.src_sucursal, l.src_c1, l.src_c2, l.src_c3, l.src_c4, l.src_c5, l.src_c6, l.fecha_captura
          FROM analytics.bank_movement_legs l
         WHERE l.tenant_id = d.tenant_id AND l.sucursal = d.kepler_sucursal
           AND l.doc_tipo = d.kepler_doc_tipo AND l.folio = d.kepler_doc_folio
         LIMIT 1) l ON true
      JOIN kepler_ods.kdm1 k
        ON k.sucursal = l.src_sucursal AND k.c1 = l.src_c1 AND k.c2 = l.src_c2 AND k.c3 = l.src_c3
       AND k.c4 = l.src_c4 AND k.c5 = l.src_c5 AND k.c6 = l.src_c6
     WHERE btrim(COALESCE(k.c67, '')) <> ''
     GROUP BY 1, 2, 3
  )
  SELECT c.tenant_id,
         c.bank_account_id,
         c.kepler_login,
         c.depositos,
         c.de_venta_sucursal,
         c.de_cobro_cliente,
         c.sucursales,
         round(c.depositos::numeric / sum(c.depositos) OVER (PARTITION BY c.tenant_id, c.bank_account_id), 3) AS parte,
         rank() OVER (PARTITION BY c.tenant_id, c.bank_account_id ORDER BY c.depositos DESC) AS lugar,
         c.ultima_captura,
         c.ultima_captura >= current_date - 7 AS capturo_esta_semana,
         ukl.user_id
    FROM cap c
    LEFT JOIN identity.user_kepler_logins ukl
      ON ukl.tenant_id = c.tenant_id AND ukl.kepler_login = c.kepler_login AND ukl.deleted_at IS NULL`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('identity').hasTable('user_kepler_logins'))) {
    await knex.raw(`
      CREATE TABLE identity.user_kepler_logins (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        user_id       uuid NOT NULL REFERENCES identity.users(id),
        kepler_login  text NOT NULL,                  -- kepler_ods.kdm1.c67, en mayúsculas y sin espacios
        note          text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        created_by    uuid,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        updated_by    uuid,
        deleted_at    timestamptz,
        deleted_by    uuid,
        CONSTRAINT user_kepler_logins_login_ck CHECK (kepler_login <> '' AND kepler_login = upper(btrim(kepler_login)))
      )`);
    await knex.raw(`CREATE UNIQUE INDEX user_kepler_logins_uno_vivo ON identity.user_kepler_logins (tenant_id, kepler_login) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX user_kepler_logins_user ON identity.user_kepler_logins (user_id)`);
    await knex.raw('ALTER TABLE identity.user_kepler_logins ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE identity.user_kepler_logins FORCE ROW LEVEL SECURITY');
  }
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'user_kepler_logins' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON identity.user_kepler_logins
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON TABLE identity.user_kepler_logins IS
    '[BFU.4.5.10] Usuario de Kepler (kdm1.c67) → usuario de la Suite. Dato propio: el ODS dice quién capturó, no quién es en la Suite.'`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON identity.user_kepler_logins TO app_runtime`);

  // DROP + CREATE (no REPLACE): una vista de otra forma en una base de desarrollo no deja cambiar columnas.
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_deposit_capturers');
  await knex.raw(VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_deposit_capturers IS
    '[BFU.4.5.10] Por cuenta de banco: quién captura en Kepler los documentos (U-A-5 venta de sucursal, U-A-7 cobro a cliente) de los depósitos que casaron en los últimos 30 días. lugar 1-2 = a quién va un depósito sin documento de esa cuenta.'`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_deposit_capturers TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: se niega si ya hay pares capturados. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_deposit_capturers');
  if (await knex.schema.withSchema('identity').hasTable('user_kepler_logins')) {
    const { rows: [r] } = await knex.raw('SELECT count(*)::int n FROM identity.user_kepler_logins');
    if (r.n > 0) throw new Error(`[BFU.4.5.10] identity.user_kepler_logins tiene ${r.n} pares: no se deshace sin perderlos`);
    await knex.raw('DROP TABLE identity.user_kepler_logins');
  }
};
