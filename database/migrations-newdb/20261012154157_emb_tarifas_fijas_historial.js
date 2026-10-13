'use strict';
/**
 * `[EMB.28.1]` — Las tarifas con las que se paga a logística quedan FIJAS: capturarlas la primera
 * vez es de quien configura; cambiarlas, borrarlas o desactivarlas es de un autorizador
 * (`LOGISTICS_TARIFAS_AUTORIZAR`), y cada movimiento queda en `logistics.tariff_changes`.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-12) ───────────────────────────────────────
 *  · `LOGISTICS_CONFIG_GESTIONAR` lo tienen `finanzas` (1 persona) y `superadmin` (8). Ningún rol
 *    de logística. Con eso, cualquiera de esas 9 personas mueve la tarifa de un viaje ya pagado.
 *  · Las tarifas no tenían historia: la comisión de CANINDO ZAMORA se editó hoy a las 15:03 y
 *    quedó en $0 (fallo del formulario, ver `aNumero`) sin que quedara rastro del valor anterior.
 *  · `config_finance` se borra DE VERDAD (hard-delete): borrar y volver a crear saltaba cualquier
 *    candado sobre el valor. Por eso el borrado también exige al autorizador.
 *
 * El permiso se reparte a `direccion` (2 personas). `superadmin` lo tiene por rol (god-mode).
 * Fuera de todo MODULE_GROUP, mismo criterio que `COMPRAS_PLAZOS_AUTORIZAR`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[emb_tarifas_fijas]';
const PERM = 'LOGISTICS_TARIFAS_AUTORIZAR';
const ROLES = ['direccion'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('logistics').hasTable('tariff_changes'))) {
    await knex.raw(`
      CREATE TABLE logistics.tariff_changes (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
        entity        text NOT NULL CHECK (entity IN ('route','config')),
        entity_id     uuid NOT NULL,
        entity_label  text NOT NULL,
        field         text NOT NULL,
        old_value     text,
        new_value     text,
        autorizado    boolean NOT NULL DEFAULT false,
        changed_by    uuid,
        changed_by_username text,
        changed_at    timestamptz NOT NULL DEFAULT now()
      )`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_tariff_changes_entity ON logistics.tariff_changes (entity, entity_id, changed_at DESC)`);
  await knex.raw('ALTER TABLE logistics.tariff_changes ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE logistics.tariff_changes FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation ON logistics.tariff_changes');
  await knex.raw(`CREATE POLICY tenant_isolation ON logistics.tariff_changes
    USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin UPDATE ni DELETE: la historia de una tarifa no se reescribe.
  await knex.raw('GRANT SELECT, INSERT ON logistics.tariff_changes TO app_runtime');
  await knex.raw(`COMMENT ON TABLE logistics.tariff_changes IS
    'EMB.28.1 — Historia de las tarifas con que se paga a logística (comisión por ruta, viáticos, maniobra de carga): quién, cuándo, valor anterior y nuevo. autorizado=true cuando el cambio tocó una tarifa ya fijada (lo hizo un LOGISTICS_TARIFAS_AUTORIZAR). Sin UPDATE/DELETE para app_runtime.'`);

  // El permiso, sólo donde no hay una decisión ya tomada (un false manual no se pisa).
  const { rows } = await knex.raw(
    `SELECT id, role_name, permissions -> ?::text AS ya
       FROM identity.role_permissions
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL`,
    [PERM, ROLES],
  );
  const nuevos = rows.filter((r) => r.ya === null);
  if (nuevos.length) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
      [JSON.stringify({ [PERM]: true }), nuevos.map((r) => r.id), PERM],
    );
  }
  console.log(`${TAG} ${PERM} otorgado a: ${nuevos.map((r) => r.role_name).join(', ') || '(nadie nuevo)'}`);
  const enFalse = rows.filter((r) => r.ya === false).map((r) => r.role_name);
  if (enFalse.length) console.log(`${TAG} en false (decisión manual, NO se pisa): ${enFalse.join(', ')}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - ?::text, updated_at = now()
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL
        AND (permissions->>?::text)::boolean IS TRUE`,
    [PERM, ROLES, PERM],
  );
  await knex.raw('DROP TABLE IF EXISTS logistics.tariff_changes');
};
