/**
 * Auditoría estructural P1 — cleanup mínimo:
 *
 * 1. Drop 2 tablas backup obsoletas del dedup de 2026-05-28. Ya no sirven —
 *    el dedup quedó cerrado y las tablas no tienen RLS ni propósito.
 *      - public.brands_dedup_backup_20260528  (10 rows)
 *      - public.products_dedup_backup_20260528 (50 rows)
 *
 * 2. Renombrar columnas de `public.vendedores_erp` para alinearse con la
 *    convención (CLAUDE.md): "columnas DB nuevas: English snake_case".
 *    La tabla es nueva (creada en M.6.1) y solo el importer la usa, así que
 *    el rename es seguro.
 *      - codigo → code
 *      - nombre → name
 *
 * Idempotente: chequea existencia antes de cada operación.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. Drop backups ──
  const dropTables = [
    'brands_dedup_backup_20260528',
    'products_dedup_backup_20260528',
  ];
  for (const t of dropTables) {
    const exists = await knex.schema.hasTable(t);
    if (exists) {
      await knex.raw(`DROP TABLE ${t} CASCADE`);
      console.log(`[cleanup] dropped public.${t}`);
    }
  }

  // ── 2. Rename vendedores_erp columns ──
  // Drop primero el UNIQUE que referencia `codigo` para poder renombrar.
  // Knex no expone rename con índice fácil — usamos raw SQL.
  const hasCodigo = await knex.schema.hasColumn('vendedores_erp', 'codigo');
  if (hasCodigo) {
    // El UNIQUE constraint se renombra automáticamente con la columna en pg,
    // pero el `indexName` que le di en knex es `vendedores_erp_tenant_codigo_unique`
    // — eso no se renombra solo. Lo dropeamos + recreamos.
    await knex.raw(`ALTER TABLE vendedores_erp DROP CONSTRAINT IF EXISTS vendedores_erp_tenant_codigo_unique`);
    await knex.raw(`ALTER TABLE vendedores_erp RENAME COLUMN codigo TO code`);
    await knex.raw(`
      ALTER TABLE vendedores_erp
        ADD CONSTRAINT vendedores_erp_tenant_code_unique UNIQUE (tenant_id, code)
    `);
    console.log(`[cleanup] vendedores_erp.codigo → code`);
  }

  const hasNombre = await knex.schema.hasColumn('vendedores_erp', 'nombre');
  if (hasNombre) {
    await knex.raw(`ALTER TABLE vendedores_erp RENAME COLUMN nombre TO name`);
    console.log(`[cleanup] vendedores_erp.nombre → name`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Revertir renames. NO recreamos las backup tables — están permanentemente perdidas.
  const hasName = await knex.schema.hasColumn('vendedores_erp', 'name');
  if (hasName) {
    await knex.raw(`ALTER TABLE vendedores_erp DROP CONSTRAINT IF EXISTS vendedores_erp_tenant_code_unique`);
    await knex.raw(`ALTER TABLE vendedores_erp RENAME COLUMN name TO nombre`);
  }
  const hasCode = await knex.schema.hasColumn('vendedores_erp', 'code');
  if (hasCode) {
    await knex.raw(`ALTER TABLE vendedores_erp RENAME COLUMN code TO codigo`);
    await knex.raw(`
      ALTER TABLE vendedores_erp
        ADD CONSTRAINT vendedores_erp_tenant_codigo_unique UNIQUE (tenant_id, codigo)
    `);
  }
};
