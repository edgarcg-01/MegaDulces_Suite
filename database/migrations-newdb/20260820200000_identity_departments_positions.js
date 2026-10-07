'use strict';
/**
 * Fase UN.1 — Normalización de usuarios: ejes DEPARTAMENTO y PUESTO.
 *
 * Problema que resuelve: hoy `users.role_name` hace DOS trabajos a la vez —
 * título del puesto y bundle de permisos. De ahí salen 30 roles de los cuales
 * 22 no tienen ningún usuario, y dos taxonomías incompatibles conviviendo
 * (legacy funcional vs presets por área de 2026-07-11), ninguna de las dos
 * alineada al ORGANIGRAMA 2026.
 *
 * La separación:
 *   - `departments` + `positions` = quién es la persona en la organización
 *     (viene del organigrama; NO otorga ni quita permisos).
 *   - `role_name` + JSONB          = qué puede hacer en la app (intacto).
 *
 * Los dos ejes son INDEPENDIENTES a propósito: fusionar roles para que
 * coincidan con el organigrama cambiaría privilegios, y el requisito es
 * preservarlos exactos (ver database/scripts/snapshot-user-privileges.js).
 *
 * `positions` es un catálogo PLANO, sin FK a departamento: un puesto como
 * `cajera` o `surtidor` aparece en varios departamentos del organigrama y el
 * departamento del usuario ya lo desambigua. `org_labels` guarda las etiquetas
 * literales del PDF — el organigrama usa 59 variantes de escritura para 43
 * puestos reales (ENC. DE SUCURSAL / ENCARGADO DE SUCURSAL, CAJERO/CAJERA/
 * CAJEROS, SUPERVISOR RD / SUPERVISOR DE RD, …) y esa canonicalización tiene
 * que quedar trazable.
 *
 * La SUCURSAL no se duplica acá: ya vive en `users.warehouse_code` ('00'..'06',
 * mapa canónico en database/importers/lib/kepler-branches.js).
 *
 * Aditiva e idempotente. No toca permisos. No borra nada.
 *
 * @param { import("knex").Knex } knex
 */

// Departamentos derivados de las ramas funcionales del ORGANIGRAMA 2026.
// `sistemas` y `externo` no están en el organigrama pero existen en la app:
// sistemas = los superadmin; externo = clientes del portal B2B (no empleados).
const DEPARTMENTS = [
  ['direccion_zona', 'Dirección de Zona', 10],
  ['tienda', 'Tienda / Piso de Venta', 20],
  ['cajas', 'Cajas', 30],
  ['ruta_directa', 'Ruta Directa (RD)', 40],
  ['ruta_vecinal', 'Ruta Vecinal (RV)', 50],
  ['telemarketing', 'Telemarketing (TLMK)', 60],
  ['mayoreo', 'Mayoreo y Venta Local', 70],
  ['almacen', 'Almacén y Recepción', 80],
  ['logistica', 'Logística', 90],
  ['operaciones', 'Operaciones', 100],
  ['administracion', 'Administración', 110],
  ['sistemas', 'Sistemas', 120],
  ['externo', 'Externo (no empleado)', 900],
];

// [code, nombre canónico, [etiquetas literales del organigrama]]
const POSITIONS = [
  ['jefe_zona', 'Jefe de zona', ['Jefe de zona']],
  ['supervisor_zona', 'Supervisor de zona', ['SUPERVISOR ZONA', 'SUPERVISOR DE ZONA']],
  ['encargado_sucursal', 'Encargado de sucursal', ['ENCARGADO DE SUCURSAL', 'ENC. DE SUCURSAL', 'ENCARGADO PADRE HIDALGO', 'ENCARGADO 8 ESQUINAS', 'ENCARGADO LA PIEDAD ABASTOS']],
  ['auxiliar_encargado', 'Auxiliar de encargado', ['AUX ENCARGADO', 'AUXILIAR DE ENCARGADO', 'AUX. DE ENCARGADO']],
  ['auxiliar_piso_venta', 'Auxiliar de piso de venta', ['AUXILIAR PISO DE VENTA']],
  ['anaquelista', 'Anaquelista', ['ANAQUELISTAS']],
  ['empaquetador', 'Empaquetador', ['EMPAQUETADOR', 'EMPAQUETADORES']],
  ['vendedor_promociones', 'Vendedor de promociones', ['VEND PROMOCIONES', 'VEND. PROMOCIONES']],
  ['surtidor_tienda', 'Surtidor de tienda', ['SURTIDOR DE TIENDA']],
  ['vendedor_piso', 'Vendedor(a) de piso', ['VENDEDORA']],
  ['encargado_cajas', 'Encargado de cajas', ['ENC. DE CAJAS']],
  ['cajera', 'Cajero(a)', ['CAJERA', 'CAJERO', 'CAJEROS', 'CAJERAS']],
  ['caja_general', 'Caja general', ['CAJA GENERAL']],
  ['supervisor_rd', 'Supervisor de Ruta Directa', ['SUPERVISOR DE RD', 'SUPERVISOR RD']],
  ['vendedor_ruta', 'Vendedor de ruta', ['VENDEDORES', 'VENDEDORES RD']],
  ['vendedor_suplente', 'Vendedor suplente', ['VENDEDOR SUPLENTE']],
  ['chofer_rd', 'Chofer de Ruta Directa', ['CHOFER RD']],
  ['supervisor_rv', 'Supervisor de Ruta Vecinal', ['SUPERVISOR DE RV']],
  ['vendedor_vecinal', 'Vendedor vecinal', ['VENDEDOR VECINAL']],
  ['cajero_rv_promotor', 'Cajero RV / Promotor / Aux. tienda', ['CAJERO RV/ PROMOTOR/ AUX. TIENDA']],
  ['almacenista_surtidor_rv', 'Almacenista / Surtidor RV', ['ALMACENISTA/ SURTIDOR RV']],
  ['coordinador_tlmk', 'Coordinador de Telemarketing', ['COORDINADOR DE TLMK']],
  ['vendedor_tlmk', 'Vendedor de Telemarketing', ['VENDEDOR DE TLMK', 'VENDEDOR TLMK']],
  ['vendedor_mayoreo', 'Vendedor de mayoreo', ['VENDEDOR DE MAYOREO']],
  ['vendedor_local', 'Vendedor local', ['VENDEDOR LOCAL']],
  ['facturador', 'Facturador', ['FACTURADOR']],
  ['almacenista', 'Almacenista', ['ALMACENISTA']],
  ['auxiliar_almacen', 'Auxiliar de almacén', ['AUXILIAR']],
  ['receptor_mercancia', 'Receptor de mercancía', ['RECEPTOR DE MERCANCIA', 'RECEPCIÓN DE MERCANCIA']],
  ['bodeguero', 'Bodeguero', ['BODEGUERO', 'BODEGUEROS']],
  ['surtidor', 'Surtidor', ['SURTIDOR', 'SURTIDORES']],
  ['checador', 'Checador', ['CHECADOR', 'CHECADORES']],
  ['encargado_logistica', 'Encargado de logística', ['ENC. LOGISTICA']],
  ['chofer_local', 'Chofer local', ['CHOFER LOCAL']],
  ['chofer_foraneo', 'Chofer foráneo', ['CHOFER FORANEO']],
  ['auxiliar_chofer', 'Auxiliar de chofer', ['AUX.DE CHOFER']],
  ['encargado_operaciones', 'Encargado de operaciones', ['ENC. DE OPERACIONES']],
  ['auxiliar_administrativo', 'Auxiliar administrativo', ['AUX. ADMINISTRATIVO']],
  ['auxiliar_compras', 'Auxiliar de compras', ['AUX. DE COMPRAS']],
  ['auxiliar_rh', 'Auxiliar de Recursos Humanos', ['AUX. DE RR-HH']],
  ['auxiliar_mkt', 'Auxiliar de Mercadotecnia', ['AUX. DE MKT']],
  ['intendencia', 'Intendencia', ['INTENDENCIA']],
  ['sistemas', 'Sistemas', []],
];

exports.up = async function up(knex) {
  // ── 1. Catálogo de departamentos ───────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasTable('departments'))) {
    await knex.raw(`
      CREATE TABLE identity.departments (
        id          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        code        varchar(50) NOT NULL,
        name        varchar(150) NOT NULL,
        orden       integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        created_by  uuid,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  uuid,
        deleted_at  timestamptz,
        deleted_by  uuid,
        PRIMARY KEY (id),
        CONSTRAINT departments_tenant_code_unique UNIQUE (tenant_id, code),
        CONSTRAINT departments_tenant_id_composite UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX idx_departments_tenant ON identity.departments (tenant_id, orden)`);
    await knex.raw(`ALTER TABLE identity.departments ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE identity.departments FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename='departments' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON identity.departments
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.departments TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE identity.departments IS 'Departamentos del organigrama. Eje ORGANIZACIONAL del usuario — NO otorga permisos (eso es role_name + JSONB).'`);
  }

  // ── 2. Catálogo de puestos (plano, canonicalizado del organigrama) ────────
  if (!(await knex.schema.withSchema('identity').hasTable('positions'))) {
    await knex.raw(`
      CREATE TABLE identity.positions (
        id          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        code        varchar(50) NOT NULL,
        name        varchar(150) NOT NULL,
        org_labels  text[] NOT NULL DEFAULT '{}',
        orden       integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        created_by  uuid,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  uuid,
        deleted_at  timestamptz,
        deleted_by  uuid,
        PRIMARY KEY (id),
        CONSTRAINT positions_tenant_code_unique UNIQUE (tenant_id, code),
        CONSTRAINT positions_tenant_id_composite UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX idx_positions_tenant ON identity.positions (tenant_id, orden)`);
    await knex.raw(`ALTER TABLE identity.positions ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE identity.positions FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename='positions' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON identity.positions
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.positions TO app_runtime`);
    await knex.raw(`COMMENT ON COLUMN identity.positions.org_labels IS 'Etiquetas LITERALES del PDF ORGANIGRAMA 2026 que se canonicalizaron a este puesto (59 variantes -> 43 puestos). Trazabilidad de la normalización.'`);
  }

  // ── 3. Los dos ejes en users ──────────────────────────────────────────────
  // Codes en texto (no UUID) por el mismo patrón que `role_name`: la vista
  // passthrough `public.users` la lee auth-mt en el login SIN contexto de
  // tenant, así que un JOIN ahí rompería el login (ver
  // feedback_fieldops_passthrough_views + feedback_permscache_first_no_tenant).
  if (!(await knex.schema.withSchema('identity').hasColumn('users', 'department_code'))) {
    await knex.raw(`ALTER TABLE identity.users ADD COLUMN department_code varchar(50)`);
    await knex.raw(`
      ALTER TABLE identity.users
        ADD CONSTRAINT fk_users_tenant_department
        FOREIGN KEY (tenant_id, department_code)
        REFERENCES identity.departments (tenant_id, code) ON DELETE SET NULL`);
    await knex.raw(`CREATE INDEX idx_users_tenant_department ON identity.users (tenant_id, department_code)`);
  }
  if (!(await knex.schema.withSchema('identity').hasColumn('users', 'position_code'))) {
    await knex.raw(`ALTER TABLE identity.users ADD COLUMN position_code varchar(50)`);
    await knex.raw(`
      ALTER TABLE identity.users
        ADD CONSTRAINT fk_users_tenant_position
        FOREIGN KEY (tenant_id, position_code)
        REFERENCES identity.positions (tenant_id, code) ON DELETE SET NULL`);
    await knex.raw(`CREATE INDEX idx_users_tenant_position ON identity.users (tenant_id, position_code)`);
  }

  // ── 4. Seeds por tenant activo (idempotente) ──────────────────────────────
  const tenants = await knex('identity.tenants').where({ activo: true }).select('id');
  for (const t of tenants) {
    for (const [code, name, orden] of DEPARTMENTS) {
      await knex.raw(
        `INSERT INTO identity.departments (tenant_id, code, name, orden)
         VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [t.id, code, name, orden],
      );
    }
    let i = 0;
    for (const [code, name, labels] of POSITIONS) {
      i += 10;
      await knex.raw(
        `INSERT INTO identity.positions (tenant_id, code, name, org_labels, orden)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [t.id, code, name, labels, i],
      );
    }
  }

  // ── 5. Recrear la vista passthrough para exponer las 2 columnas nuevas ────
  // CREATE OR REPLACE VIEW solo AGREGA columnas al final -> seguro.
  await knex.raw(`
    CREATE OR REPLACE VIEW public.users AS
      SELECT id, tenant_id, username, password_hash, nombre, zona_id, role_name,
             supervisor_id, activo, meta_puntos, created_at, created_by,
             updated_at, updated_by, deleted_at, deleted_by, customer_id,
             last_login_at, last_login_ip, last_login_user_agent, warehouse_code,
             finance_expense_area_ids,
             department_code, position_code
        FROM identity.users`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW public.users AS
      SELECT id, tenant_id, username, password_hash, nombre, zona_id, role_name,
             supervisor_id, activo, meta_puntos, created_at, created_by,
             updated_at, updated_by, deleted_at, deleted_by, customer_id,
             last_login_at, last_login_ip, last_login_user_agent, warehouse_code,
             finance_expense_area_ids
        FROM identity.users`);
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS fk_users_tenant_position`);
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS fk_users_tenant_department`);
  await knex.raw(`ALTER TABLE identity.users DROP COLUMN IF EXISTS position_code`);
  await knex.raw(`ALTER TABLE identity.users DROP COLUMN IF EXISTS department_code`);
  await knex.schema.withSchema('identity').dropTableIfExists('positions');
  await knex.schema.withSchema('identity').dropTableIfExists('departments');
};
