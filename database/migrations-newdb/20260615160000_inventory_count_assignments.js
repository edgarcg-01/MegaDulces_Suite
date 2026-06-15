/**
 * Fase I.4 — asignación de personas a un folio de inventario específico.
 *
 * commercial.inventory_count_assignments: qué contadores y qué supervisores
 * trabajan un folio dado. Opt-in por folio: si un folio tiene contadores
 * asignados, solo ellos lo cuentan; si no tiene ninguno, queda abierto a
 * cualquiera con CONTAR (compat hacia atrás).
 *
 * + permiso COMMERCIAL_INVENTORY_ASIGNAR (quién puede asignar) → supervisor/
 * admin/superadmin (backfill idempotente).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_count_assignments'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_count_assignments', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('count_id').notNullable();
      t.uuid('user_id').notNullable();
      t.string('assignment_role', 12).notNullable(); // 'counter' | 'supervisor'
      t.uuid('assigned_by');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'count_id', 'user_id', 'assignment_role'], { indexName: 'commercial_inv_assign_unique' });
      t.check(`?? IN ('counter','supervisor')`, ['assignment_role'], 'commercial_inv_assign_role_valid');
      t.index(['tenant_id', 'count_id'], 'idx_commercial_inv_assign_count');
      t.index(['tenant_id', 'user_id'], 'idx_commercial_inv_assign_user');
    });
    await knex.raw(`ALTER TABLE commercial.inventory_count_assignments ADD CONSTRAINT fk_inv_assign_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_assignments ADD CONSTRAINT fk_inv_assign_count FOREIGN KEY (tenant_id, count_id) REFERENCES commercial.inventory_counts(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_assignments ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_assignments FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_count_assignments`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.inventory_count_assignments USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_count_assignments TO app_runtime`);
  }

  // Permiso ASIGNAR → roles que ya supervisan.
  const patch = JSON.stringify({ COMMERCIAL_INVENTORY_ASIGNAR: true });
  const r = await knex.raw(
    `UPDATE role_permissions SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles) AND permissions -> 'COMMERCIAL_INVENTORY_ASIGNAR' IS NULL`,
    { patch, roles: ['superadmin', 'admin', 'supervisor'] });
  console.log(`[inventory_count_assignments] COMMERCIAL_INVENTORY_ASIGNAR otorgado a ${r.rowCount ?? 0} rol(es).`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_count_assignments');
};
