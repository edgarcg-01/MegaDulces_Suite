/**
 * Migración: tablas core de identidad y autorización para schema multi-tenant.
 *
 * Tablas creadas:
 *   1. zones                — zonas geográficas por tenant
 *   2. role_permissions     — definición de roles + permisos JSONB por tenant
 *   3. users                — usuarios del tenant (con FK composite a zones y roles)
 *   4. catalogs             — catálogo genérico (rutas, conceptos, niveles)
 *
 * Convenciones aplicadas:
 *   - tenant_id UUID NOT NULL FK → tenants(id)
 *   - Audit fields completos: created_at/by + updated_at/by + deleted_at/by
 *   - Unique composite (tenant_id, slug-like) en lugar de unique global
 *   - FK composite (tenant_id, id) entre tablas multi-tenant → enforcement
 *     a nivel DB de que cross-references siempre matchean tenant
 *   - RLS policy `tenant_isolation` en cada tabla con USING + WITH CHECK
 *   - Índices en tenant_id + por columnas frecuentemente consultadas
 *
 * Las RLS policies aplican AUTOMÁTICAMENTE cualquier filtro `WHERE tenant_id =
 * current_tenant_id()` (función creada en migración 0001). Si el código del API
 * tiene un bug y olvida el WHERE, RLS bloquea cualquier select/insert/update/
 * delete cross-tenant.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. ZONES — zonas geográficas (LA PIEDAD, ZAMORA, etc.)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('zones', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('name', 100).notNullable();
    table.integer('orden').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by'); // FK a users se agrega después de crear users (chicken-and-egg)
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'name'], { indexName: 'zones_tenant_name_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'zones_tenant_id_composite' }); // para composite FK
    table.index('tenant_id', 'idx_zones_tenant');
    table.index(['tenant_id', 'orden'], 'idx_zones_tenant_orden');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. ROLE_PERMISSIONS — roles + JSONB de permisos por tenant
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('role_permissions', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('role_name', 50).notNullable();
    table.jsonb('permissions').notNullable().defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'role_name'], { indexName: 'role_permissions_tenant_role_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'role_permissions_tenant_id_composite' });
    table.index('tenant_id', 'idx_role_permissions_tenant');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. USERS — usuarios del tenant
  // FKs:
  //   - tenant_id → tenants(id)
  //   - composite (tenant_id, zona_id) → zones(tenant_id, id) [enforced cross-tenant]
  //   - composite (tenant_id, role_name) → role_permissions(tenant_id, role_name)
  //   - supervisor_id → users(id) [self FK, mismo tenant garantizado por RLS]
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('username', 100).notNullable();
    table.string('password_hash', 255).notNullable();
    table.string('nombre', 150);
    table.uuid('zona_id');
    table.string('role_name', 50).notNullable();
    table.uuid('supervisor_id'); // FK a users(id) sin composite — RLS protege cross-tenant
    table.boolean('activo').notNullable().defaultTo(true);
    table.integer('meta_puntos').notNullable().defaultTo(5000);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'username'], { indexName: 'users_tenant_username_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'users_tenant_id_composite' });

    // Composite FKs cross-tenant safe
    table.foreign(['tenant_id', 'zona_id'], 'fk_users_tenant_zona')
      .references(['tenant_id', 'id']).inTable('zones').onDelete('SET NULL');
    table.foreign(['tenant_id', 'role_name'], 'fk_users_tenant_role')
      .references(['tenant_id', 'role_name']).inTable('role_permissions').onDelete('RESTRICT');
    table.foreign('supervisor_id', 'fk_users_supervisor')
      .references('id').inTable('users').onDelete('SET NULL');

    table.index('tenant_id', 'idx_users_tenant');
    table.index(['tenant_id', 'activo'], 'idx_users_tenant_activo');
    table.index(['tenant_id', 'role_name'], 'idx_users_tenant_role');
    table.index(['tenant_id', 'supervisor_id'], 'idx_users_tenant_supervisor');
  });

  // Ahora que users existe, agregamos FK created_by/updated_by/deleted_by en
  // zones y role_permissions (auto-referenciales no fueron posibles antes).
  await knex.schema.alterTable('zones', (table) => {
    table.foreign('created_by', 'fk_zones_created_by').references('id').inTable('users').onDelete('SET NULL');
    table.foreign('updated_by', 'fk_zones_updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.foreign('deleted_by', 'fk_zones_deleted_by').references('id').inTable('users').onDelete('SET NULL');
  });
  await knex.schema.alterTable('role_permissions', (table) => {
    table.foreign('created_by', 'fk_role_permissions_created_by').references('id').inTable('users').onDelete('SET NULL');
    table.foreign('updated_by', 'fk_role_permissions_updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.foreign('deleted_by', 'fk_role_permissions_deleted_by').references('id').inTable('users').onDelete('SET NULL');
  });
  // El mismo audit FK en users (self-ref)
  await knex.schema.alterTable('users', (table) => {
    table.foreign('created_by', 'fk_users_created_by').references('id').inTable('users').onDelete('SET NULL');
    table.foreign('updated_by', 'fk_users_updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.foreign('deleted_by', 'fk_users_deleted_by').references('id').inTable('users').onDelete('SET NULL');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. CATALOGS — catálogo genérico (rutas, conceptos, niveles, etc.)
  // El parent_id permite jerarquías (ej: zone → rutas dentro de la zone)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('catalogs', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('catalog_id', 50).notNullable(); // tipo de catálogo: rutas, conceptos, niveles
    table.string('value', 200).notNullable();
    table.integer('orden').notNullable().defaultTo(0);
    table.decimal('puntuacion', 5, 2).notNullable().defaultTo(0);
    table.string('icono', 100);
    table.uuid('parent_id'); // self-FK opcional para jerarquías
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'catalog_id', 'value'], { indexName: 'catalogs_tenant_type_value_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'catalogs_tenant_id_composite' });

    // Composite FK self → mismo tenant
    table.foreign(['tenant_id', 'parent_id'], 'fk_catalogs_tenant_parent')
      .references(['tenant_id', 'id']).inTable('catalogs').onDelete('CASCADE');

    table.index('tenant_id', 'idx_catalogs_tenant');
    table.index(['tenant_id', 'catalog_id'], 'idx_catalogs_tenant_type');
    table.index(['tenant_id', 'catalog_id', 'parent_id'], 'idx_catalogs_tenant_type_parent');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. RLS — Row-Level Security en las 4 tablas
  // Defense-in-depth: si el código olvida `WHERE tenant_id`, RLS bloquea.
  // USING aplica a SELECT/UPDATE/DELETE. WITH CHECK aplica a INSERT/UPDATE.
  // ─────────────────────────────────────────────────────────────────────────
  for (const t of ['zones', 'role_permissions', 'users', 'catalogs']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); // aplica incluso al owner
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }

  // Comentarios para futuros mantenedores
  await knex.raw(`COMMENT ON TABLE users IS 'Usuarios del tenant. RLS activo: solo visible/escribible con app.tenant_id seteado.'`);
  await knex.raw(`COMMENT ON TABLE catalogs IS 'Tabla genérica EAV: rutas, conceptos, niveles, etc. Cada fila tiene catalog_id que indica su tipo. parent_id permite jerarquías (zone→rutas).'`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // Orden inverso: catalogs → users → role_permissions → zones (por dependencias)
  await knex.schema.dropTableIfExists('catalogs');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('zones');
};
