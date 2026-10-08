'use strict';
/**
 * `[GP.4]` — El checado: rastrillar el pedido, armar las cajas P y etiquetar (`FASE_GP` §9).
 *
 * El checador recibe con "Tomar siguiente" un pedido ya surtido y que Facturación ya pasó a
 * SURTIDO en Kepler (GP.3d), nunca uno en el que él surtió algo (P4). Escanea todo: las cajas de
 * unidad mayor validan el surtido; la paquetería se escanea DENTRO de la caja P abierta, para que
 * quede escrito qué va en cada caja (decisión de Francisco, 2026-10-08). Lo que cuenta el checador
 * es lo que sale (P7: si falta, sale incompleto).
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  1. `commercial.order_checks`        el checado de un pedido (quién, estado, dónde espera).
 *  2. `commercial.order_check_lines`   por producto: lo esperado, lo checado y quién lo surtió.
 *  3. `commercial.check_packages`      las cajas P (número, abierta/cerrada, etiqueta impresa).
 *  4. `commercial.check_scans`         cada escaneo (código, unidad, factor, caja P, peso).
 *  5. Permiso `ALMACEN_CHECADO_GESTIONAR` → rol nuevo `checador` + `almacenista` (la misma persona
 *     puede surtir un día y checar otro: P4 lo cuida el sistema por pedido, no el perfil).
 *  6. Rol `checador` con alcance a su sucursal y su zona (fail-closed: sin esto no ve nada).
 *  7. Puesto `checador_pedidos` ("Checador de Pedidos") que propone `checador`. El puesto
 *     "Checador" ya lo ocupa la terminal del verificador de precios (`checador.05`, perfil
 *     `verificador_precios`): darle ahí el perfil de almacén se lo daría a una terminal pública.
 *     `checador_cedis` (0 personas, sin perfil) también pasa a proponer `checador`.
 *
 * ── Lo aprendido con el surtidor (GP.3), resuelto aquí ──────────────────────────────────────
 *  · El rol nace por migración CON alcance (el `surtidor` se creó a mano sin alcance y no veía
 *    ninguna sucursal).
 *  · Rol y puesto van en la MISMA migración que crea tablas: la compuerta del despliegue la
 *    clasifica como esquema y no frena (una de sólo datos frena a todo el equipo).
 *
 * Va ANTES del código. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const PERMISO = 'ALMACEN_CHECADO_GESTIONAR';
const ROL = 'checador';
const CLAVES_ROL = [PERMISO, 'ALMACEN_UBICACIONES_VER', 'SERVICIO_REPORTAR'];
const ALCANCE = { brand: 'none', customer: 'none', expense_area: 'none', route: 'none', warehouse: 'own', zone: 'own' };
/** Además del rol nuevo: quien ya surte puede checar (nunca lo que él surtió). */
const ROLES_CON_PERMISO = ['almacenista'];

async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON commercial.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tabla = (t) => knex.schema.withSchema('commercial').hasTable(t);

  // ── 1. El checado de un pedido ───────────────────────────────────────────────────────────
  if (!(await tabla('order_checks'))) {
    await knex.raw(`
      CREATE TABLE commercial.order_checks (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL DEFAULT public.current_tenant_id(),
        warehouse_id     uuid NOT NULL REFERENCES commercial.warehouses(id),
        wave_id          uuid NOT NULL REFERENCES commercial.picking_waves(id),
        order_id         uuid NOT NULL,
        order_code       varchar(40) NOT NULL,
        kepler_sucursal  varchar(4),
        kepler_serie     smallint,
        kepler_folio     varchar(20),
        destino_nombre   varchar(120),
        status           varchar(12) NOT NULL DEFAULT 'en_checado'
                         CHECK (status IN ('en_checado', 'checado', 'cancelado')),
        assigned_to      uuid NOT NULL,
        started_at       timestamptz NOT NULL DEFAULT now(),
        finished_at      timestamptz,
        wait_location    varchar(40),
        notes            text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       uuid,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       uuid
      )`);
    // Un pedido se checa una vez a la vez: el candado contra dos checadores sobre el mismo pedido.
    await knex.raw(`CREATE UNIQUE INDEX ux_order_checks_vivo ON commercial.order_checks (tenant_id, order_id)
                    WHERE status <> 'cancelado'`);
    await knex.raw(`CREATE INDEX ix_order_checks_quien ON commercial.order_checks (tenant_id, assigned_to, status)`);
    await knex.raw(`CREATE INDEX ix_order_checks_wave ON commercial.order_checks (tenant_id, wave_id)`);
    await tenantRls(knex, 'order_checks');
    await knex.raw(`COMMENT ON TABLE commercial.order_checks IS
      '[GP.4] El checado de un pedido surtido: quién lo checa (nunca quien lo surtió), estado y dónde queda esperando la unidad.'`);
  }

  // ── 2. Renglones del checado ─────────────────────────────────────────────────────────────
  if (!(await tabla('order_check_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.order_check_lines (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL DEFAULT public.current_tenant_id(),
        check_id         uuid NOT NULL REFERENCES commercial.order_checks(id) ON DELETE CASCADE,
        product_id       uuid NOT NULL,
        sku              varchar(20),
        product_name     varchar(200),
        qty_unit         varchar(12),
        qty_expected     numeric(14,3) NOT NULL,
        qty_checked      numeric(14,3) NOT NULL DEFAULT 0,
        unidad_mayor     varchar(12),
        factor_mayor     numeric(14,3),
        se_pesa          boolean NOT NULL DEFAULT false,
        weight_kg        numeric(14,3),
        picked_by        uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (check_id, product_id)
      )`);
    await tenantRls(knex, 'order_check_lines');
    await knex.raw(`COMMENT ON TABLE commercial.order_check_lines IS
      '[GP.4] Por producto: lo esperado (lo surtido, ya en Kepler), lo checado y quién lo surtió. Unidad base.'`);
  }

  // ── 3. Cajas P ───────────────────────────────────────────────────────────────────────────
  if (!(await tabla('check_packages'))) {
    await knex.raw(`
      CREATE TABLE commercial.check_packages (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL DEFAULT public.current_tenant_id(),
        check_id         uuid NOT NULL REFERENCES commercial.order_checks(id) ON DELETE CASCADE,
        numero           smallint NOT NULL CHECK (numero > 0),
        status           varchar(10) NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'cerrada')),
        closed_at        timestamptz,
        label_printed_at timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       uuid,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (check_id, numero)
      )`);
    // Una sola caja P abierta por checado: lo que se escanea cae en ESA.
    await knex.raw(`CREATE UNIQUE INDEX ux_check_packages_abierta ON commercial.check_packages (check_id) WHERE status = 'abierta'`);
    await tenantRls(knex, 'check_packages');
    await knex.raw(`COMMENT ON TABLE commercial.check_packages IS
      '[GP.4] Cajas P de paquetería: qué va en cada caja se sabe por check_scans.package_id.'`);
  }

  // ── 4. Escaneos ──────────────────────────────────────────────────────────────────────────
  if (!(await tabla('check_scans'))) {
    await knex.raw(`
      CREATE TABLE commercial.check_scans (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL DEFAULT public.current_tenant_id(),
        check_id         uuid NOT NULL REFERENCES commercial.order_checks(id) ON DELETE CASCADE,
        line_id          uuid REFERENCES commercial.order_check_lines(id) ON DELETE CASCADE,
        package_id       uuid REFERENCES commercial.check_packages(id),
        code             varchar(40) NOT NULL,
        sku              varchar(20),
        unidad           varchar(12),
        factor           numeric(14,3) NOT NULL DEFAULT 1,
        qty_units        numeric(14,3) NOT NULL,
        qty_base         numeric(14,3) NOT NULL,
        kind             varchar(8) NOT NULL CHECK (kind IN ('mayor', 'menor', 'ajeno')),
        weight_kg        numeric(14,3),
        scanned_by       uuid,
        scanned_at       timestamptz NOT NULL DEFAULT now(),
        undone_at        timestamptz,
        CHECK (kind <> 'menor' OR package_id IS NOT NULL)
      )`);
    await knex.raw(`CREATE INDEX ix_check_scans_check ON commercial.check_scans (check_id, scanned_at)`);
    await tenantRls(knex, 'check_scans');
    await knex.raw(`COMMENT ON TABLE commercial.check_scans IS
      '[GP.4] Cada escaneo del checador. mayor = una caja de unidad mayor (CJ); menor = paquetería dentro de la caja P abierta; ajeno = no va en el pedido (no suma).'`);
  }

  // ── 5-7. Permiso, rol, puesto ────────────────────────────────────────────────────────────
  const { rows: tenants } = await knex.raw(`SELECT id, slug FROM identity.tenants WHERE deleted_at IS NULL ORDER BY slug`);
  const permisosRol = JSON.stringify(Object.fromEntries(CLAVES_ROL.map((k) => [k, true])));
  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES (?, ?, ?::jsonb)
       ON CONFLICT (tenant_id, role_name) DO UPDATE
         SET permissions = role_permissions.permissions || ?::jsonb, updated_at = now()`,
      [t.id, ROL, permisosRol, permisosRol],
    );
    for (const [dimension, mode] of Object.entries(ALCANCE)) {
      await knex.raw(
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, values)
         VALUES (?, ?, ?, '*', ?, NULL)
         ON CONFLICT (tenant_id, role_name, dimension, area) DO UPDATE
           SET mode = EXCLUDED.mode, values = NULL, updated_at = now()`,
        [t.id, ROL, dimension, mode],
      );
    }
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true), updated_at = now()
        WHERE tenant_id = ? AND deleted_at IS NULL AND permissions -> ? IS NULL AND role_name = ANY(?::text[])
        RETURNING role_name`,
      [PERMISO, t.id, PERMISO, ROLES_CON_PERMISO],
    );
    await knex.raw(
      `INSERT INTO identity.positions (tenant_id, code, name, org_labels, orden, department_code, default_role,
                                       reports_to_position_code, nivel, proposito)
       SELECT ?, 'checador_pedidos', 'Checador de Pedidos', '["unidad:sucursal"]'::jsonb, 765, 'almacen', ?,
              'embarques', 'operativo',
              'Checar cada pedido surtido escaneando todo, armar las cajas de paquetería y etiquetarlas.'
        WHERE NOT EXISTS (SELECT 1 FROM identity.positions WHERE tenant_id = ? AND code = 'checador_pedidos')`,
      [t.id, ROL, t.id],
    );
    await knex.raw(
      `UPDATE identity.positions SET default_role = ?, updated_at = now()
        WHERE tenant_id = ? AND code = 'checador_cedis' AND default_role IS NULL`,
      [ROL, t.id],
    );
    console.log(`  ✓ [${t.slug}] rol ${ROL} + alcance; ${PERMISO} → ${r.rows.map((x) => x.role_name).join(', ') || '(nadie nuevo)'}; puesto checador_pedidos.`);
  }

  // Gate: el rol quedó con sus 6 dimensiones y ninguna abierta.
  const { rows: dims } = await knex.raw(`SELECT mode FROM identity.role_scopes WHERE role_name = ? AND area = '*'`, [ROL]);
  if (dims.length < Object.keys(ALCANCE).length * tenants.length) throw new Error(`El rol ${ROL} quedó con ${dims.length} reglas de alcance.`);
  if (dims.some((d) => d.mode === 'all')) throw new Error(`El rol ${ROL} quedó con alcance 'all'.`);
};

/** Deshace lo que hizo el `up`. Los checados capturados son trabajo de piso: sólo se deshace vacío. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL row_security = off`);
  if (await knex.schema.withSchema('commercial').hasTable('order_checks')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.order_checks`);
    if (rows[0].n > 0) throw new Error(`[GP.4] down abortado: commercial.order_checks tiene ${rows[0].n} fila(s).`);
  }
  for (const t of ['check_scans', 'check_packages', 'order_check_lines', 'order_checks']) {
    await knex.raw(`DROP TABLE IF EXISTS commercial.${t}`);
  }
  const { rows: cuentas } = await knex.raw(`SELECT count(*)::int AS n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`, [ROL]);
  if (cuentas[0].n === 0) {
    await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ? AND area = '*'`, [ROL]);
    await knex.raw(`DELETE FROM identity.role_permissions WHERE role_name = ?`, [ROL]);
    await knex.raw(`DELETE FROM identity.positions WHERE code = 'checador_pedidos'
                     AND NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.position_code = 'checador_pedidos')`);
  }
  await knex.raw(`UPDATE identity.positions SET default_role = NULL WHERE code = 'checador_cedis' AND default_role = ?`, [ROL]);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now()
      WHERE role_name = ANY(?::text[]) AND (permissions -> ?)::text = 'true'`,
    [PERMISO, ROLES_CON_PERMISO, PERMISO],
  );
};
