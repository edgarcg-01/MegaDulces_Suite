'use strict';
/**
 * `[BFU.4.5.10]` — **Quién responde por los depósitos de cada sucursal se DERIVA de Kepler**, no se configura a mano
 * (anexo BFU, BFU.4.5; investigación `FASE_CB_ANEXO_BFU_INVESTIGACION_AREAS.md`, P6).
 *
 * Un depósito sin documento lo resuelve quien captura su documento en Kepler: la venta de la sucursal (`U-A-5`) o el
 * cobro a un cliente (`U-A-7`). Esa persona ya está en el ODS: `kdm1.c67`, el usuario que capturó.
 *
 *  · `analytics.v_kepler_deposit_capturers` (vista, derive-no-copy): por sucursal y tipo de documento, quién capturó
 *    los documentos de depósito de los últimos 30 días, cuántos, su parte y su lugar. Fresca sin mantenimiento.
 *  · `identity.user_kepler_logins` (dato propio): el par «usuario de Kepler → usuario de la Suite». Es la única
 *    pregunta que el ODS no contesta; nace VACÍA y se llena como parámetro (Edgar / Sistemas). Un usuario de la Suite
 *    puede tener varios logins de Kepler; un login, un solo usuario vivo.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-24) ──────────────────────────────────
 *  · 2,850 documentos `U-A-5`/`U-A-7` con captura en los últimos 30 días; el cruce con `kdm1` da 2,850 (no infla:
 *    la llave es sucursal + c1..c6) y 2,850 folios distintos. La consulta, 89 ms.
 *  · `U-A-5`: 5 usuarios principales se reparten las 9 sucursales; `U-A-7`: un usuario (dos logins).
 *  · De los 10 logins, sólo 1 tiene un usuario homónimo en la Suite: el par no se puede adivinar por nombre.
 *  · Cada sucursal tiene un capturista dominante (79–100 % de sus documentos), pero el que más capturó no siempre es
 *    el de hoy: en Zamora Centro el primero no captura desde el 13-nov y el segundo sí. Por eso `capturo_esta_semana`:
 *    quien consuma la vista no debe mandar el pendiente a alguien que dejó de capturar.
 *  · Cobro a cliente (`U-A-7`) sólo aparece en Padre Hidalgo, Canindo y Morelia Abastos: las demás no tienen fila y
 *    eso se declara, no se rellena.
 *  · ⚠️ Kepler sobrescribe `c67` al cancelar (ERP_KEPLER / memoria): un documento cancelado diría quién lo canceló.
 *    `kdm1.c11` en estos documentos es texto libre («TARJETA», «RD CANINDO»), no un estado: no hay con qué filtrar.
 *    Se declara; en 30 días pesa poco frente a cientos de capturas.
 *
 * Aditiva e idempotente: una tabla nueva vacía y una vista nueva; la API desplegada no las lee.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
  CREATE OR REPLACE VIEW analytics.v_kepler_deposit_capturers AS
  WITH docs AS (
    SELECT DISTINCT l.tenant_id, l.sucursal, l.doc_tipo, l.folio, l.fecha_captura,
           l.src_sucursal, l.src_c1, l.src_c2, l.src_c3, l.src_c4, l.src_c5, l.src_c6
      FROM analytics.bank_movement_legs l
     WHERE l.doc_tipo IN ('U-A-5', 'U-A-7')
       AND l.fecha_captura >= current_date - 30
  ), cap AS (
    SELECT d.tenant_id, d.sucursal, d.doc_tipo, upper(btrim(k.c67)) AS kepler_login,
           count(*)::int AS docs, max(d.fecha_captura) AS ultima_captura
      FROM docs d
      JOIN kepler_ods.kdm1 k
        ON k.sucursal = d.src_sucursal AND k.c1 = d.src_c1 AND k.c2 = d.src_c2 AND k.c3 = d.src_c3
       AND k.c4 = d.src_c4 AND k.c5 = d.src_c5 AND k.c6 = d.src_c6
     WHERE btrim(COALESCE(k.c67, '')) <> ''
     GROUP BY 1, 2, 3, 4
  )
  SELECT c.tenant_id,
         c.sucursal,
         c.doc_tipo,
         CASE c.doc_tipo WHEN 'U-A-5' THEN 'venta_sucursal' ELSE 'cobro_cliente' END AS deposito,
         c.kepler_login,
         c.docs,
         round(c.docs::numeric / sum(c.docs) OVER (PARTITION BY c.tenant_id, c.sucursal, c.doc_tipo), 3) AS parte,
         rank() OVER (PARTITION BY c.tenant_id, c.sucursal, c.doc_tipo ORDER BY c.docs DESC) AS lugar,
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

  await knex.raw(VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_deposit_capturers IS
    '[BFU.4.5.10] Quién captura en Kepler los depósitos (U-A-5 venta de sucursal, U-A-7 cobro a cliente) de cada sucursal, últimos 30 días. lugar = 1 es el responsable derivado.'`);
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
