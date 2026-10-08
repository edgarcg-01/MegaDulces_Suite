'use strict';
/**
 * `[GP.3c.2]` — La consola de surtido: quién prioriza la fila.
 *
 * Pregunta de Francisco (2026-10-08) al ver "Tomar siguiente" en prod: ¿quién prioriza la fila,
 * quién decide tandas o partir un pedido? Hoy NADIE: la fila va por antigüedad y el umbral de la
 * tanda (5 renglones) está fijo en el código. Decisiones (FASE_GP §8.3):
 *   · Prioriza el COORDINADOR (no el surtidor): marca urgentes y captura la hora de salida de cada
 *     destino; la fila va por urgente → salida más próxima → lo más viejo.
 *   · El umbral de la tanda se ajusta por almacén.
 *
 * Qué crea:
 *   1. `picking_waves.prioridad` (0 normal / 1 urgente) + motivo, quién y cuándo.
 *   2. `wave_orders.destino_code/destino_nombre`: el destino del pedido (Kepler `kdm1.c10`/`c32`),
 *      guardado al armar la ola para que la fila se ordene sin releer Kepler en cada "tomar".
 *   3. `commercial.picking_departures`: la hora de salida que captura el coordinador, por almacén,
 *      día y destino.
 *   4. `commercial.picking_settings`: el umbral de la tanda por almacén (default 5).
 *   5. Reparte `ALMACEN_SURTIDO_COORDINAR`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-08) ────────────────────────────────────────
 *  · Roles pedidos: `coordinador_embarques` (1 persona), `encargado_tienda` (7), `supervisor` (1).
 *  · "Gerente de zona": el rol `retirado_gerente_de_zona` tiene 0 personas; el PUESTO "Gerencia de
 *    Zona" (`jefe_zona`) lo ocupan 3 personas y las 3 son `superadmin` → ya ven todo. Su rol por
 *    omisión es `supervisor_ventas` (5 supervisores de VENTAS): no se le da, no es de almacén.
 *  · Ninguna fila de `role_permissions` trae ya la clave (es nueva): `-> 'X' IS NULL` alcanza.
 *  · `commercial.picking_waves`: olas reales en prod desde el 08-oct (Morelia Abastos).
 *
 * ⚠️ Los 9 tienen que volver a entrar para ver la consola: el permiso viaja en el JWT. No se
 *    revocan sesiones a la fuerza (sacaría a los encargados a media jornada).
 *
 * Crea esquema: la compuerta del despliegue la clasifica y no frena. Va ANTES del código.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const PERMISO = 'ALMACEN_SURTIDO_COORDINAR';
const ROLES = ['coordinador_embarques', 'encargado_tienda', 'supervisor'];

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
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const col = (tabla, c) => knex.schema.withSchema('commercial').hasColumn(tabla, c);

  // ── 1. Prioridad de la ola ──────────────────────────────────────────────────────────────────
  if (!(await col('picking_waves', 'prioridad'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves
      ADD COLUMN prioridad smallint NOT NULL DEFAULT 0 CHECK (prioridad IN (0, 1))`);
  }
  if (!(await col('picking_waves', 'prioridad_motivo'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves ADD COLUMN prioridad_motivo text`);
  }
  if (!(await col('picking_waves', 'prioridad_por'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves ADD COLUMN prioridad_por uuid`);
  }
  if (!(await col('picking_waves', 'prioridad_at'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves ADD COLUMN prioridad_at timestamptz`);
  }

  // ── 2. El destino de cada pedido de la ola ──────────────────────────────────────────────────
  if (!(await col('wave_orders', 'destino_code'))) {
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN destino_code varchar(20)`);
  }
  if (!(await col('wave_orders', 'destino_nombre'))) {
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN destino_nombre varchar(120)`);
  }

  // ── 3. Hora de salida por destino ───────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('picking_departures'))) {
    await knex.raw(`
      CREATE TABLE commercial.picking_departures (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL DEFAULT public.current_tenant_id(),
        warehouse_id    uuid NOT NULL,
        fecha           date NOT NULL,
        destino_code    varchar(20) NOT NULL,
        destino_nombre  varchar(120),
        hora_salida     time NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        created_by      uuid,
        updated_at      timestamptz NOT NULL DEFAULT now(),
        updated_by      uuid,
        UNIQUE (tenant_id, warehouse_id, fecha, destino_code)
      )`);
    await tenantRls(knex, 'commercial', 'picking_departures');
    await knex.raw(`COMMENT ON TABLE commercial.picking_departures IS
      '[GP.3c] Hora de salida que captura el coordinador por almacén, día y destino (Kepler kdm1.c10). Ordena la fila de "tomar siguiente": urgente, salida más próxima, lo más viejo.'`);
  }

  // ── 4. Umbral de la tanda por almacén ───────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('picking_settings'))) {
    await knex.raw(`
      CREATE TABLE commercial.picking_settings (
        tenant_id      uuid NOT NULL DEFAULT public.current_tenant_id(),
        warehouse_id   uuid NOT NULL,
        umbral_tanda   smallint NOT NULL DEFAULT 5 CHECK (umbral_tanda BETWEEN 1 AND 50),
        created_at     timestamptz NOT NULL DEFAULT now(),
        created_by     uuid,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     uuid,
        PRIMARY KEY (tenant_id, warehouse_id)
      )`);
    await tenantRls(knex, 'commercial', 'picking_settings');
    await knex.raw(`COMMENT ON TABLE commercial.picking_settings IS
      '[GP.3c] Ajustes del surtido por almacén. umbral_tanda: hasta cuántos renglones un pedido va en tanda con otros (sin fila = 5, la regla de Francisco del 2026-10-07).'`);
  }

  // ── 5. Reparto del permiso ──────────────────────────────────────────────────────────────────
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (tenant) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true), updated_at = now()
        WHERE tenant_id = ? AND deleted_at IS NULL AND permissions -> ? IS NULL
          AND role_name = ANY(?::text[])
        RETURNING role_name`,
      [PERMISO, tenant, PERMISO, ROLES],
    );
    console.log(`  [GP.3c] ${PERMISO} → ${r.rows.map((x) => x.role_name).sort().join(', ') || '(nadie nuevo)'}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (tenant) {
    // Sólo donde el up la dejó en true; un false puesto a mano después se respeta.
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now()
        WHERE tenant_id = ? AND role_name = ANY(?::text[]) AND (permissions -> ?)::text = 'true'`,
      [PERMISO, tenant, ROLES, PERMISO],
    );
  }
  // Las horas capturadas y los ajustes son trabajo del coordinador: sólo se deshace vacío.
  for (const t of ['picking_departures', 'picking_settings']) {
    if (await knex.schema.withSchema('commercial').hasTable(t)) {
      const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.${t}`);
      if (rows[0].n > 0) throw new Error(`[GP.3c] down abortado: commercial.${t} tiene ${rows[0].n} fila(s).`);
      await knex.raw(`DROP TABLE commercial.${t}`);
    }
  }
  await knex.raw(`ALTER TABLE commercial.wave_orders
    DROP COLUMN IF EXISTS destino_nombre,
    DROP COLUMN IF EXISTS destino_code`);
  await knex.raw(`ALTER TABLE commercial.picking_waves
    DROP COLUMN IF EXISTS prioridad_at,
    DROP COLUMN IF EXISTS prioridad_por,
    DROP COLUMN IF EXISTS prioridad_motivo,
    DROP COLUMN IF EXISTS prioridad`);
};
