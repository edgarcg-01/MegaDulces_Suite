#!/usr/bin/env node
/**
 * Migración de data legacy → nueva DB multi-tenant.
 *
 * Lee de LEGACY_DATABASE_URL, escribe en DATABASE_URL_NEW (postgres superuser
 * para bypass RLS — el seed inicial de un tenant requiere esto).
 *
 * Todas las rows del legacy se asignan al tenant Mega Dulces. UUIDs se
 * mantienen para preservar FKs entre tablas.
 *
 * Uso:
 *   node database/migrate-legacy-to-newdb.js --dry-run    # Solo cuenta
 *   node database/migrate-legacy-to-newdb.js              # Migra real
 *   node database/migrate-legacy-to-newdb.js --only=users # Solo una tabla
 *
 * Orden respeta dependencias (FKs). Idempotente: usa onConflict ignore.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const knex = require('knex');

const TENANT_ID = '00000000-0000-0000-0000-00000000d01c'; // Mega Dulces
const SUPEROOT_USER_ID = '00000000-0000-0000-0000-00000000d0aa';

const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');

const legacy = knex({
  client: 'pg',
  connection: { connectionString: process.env.LEGACY_DATABASE_URL },
  pool: { min: 1, max: 5 },
});

const newdb = knex({
  client: 'pg',
  connection: { connectionString: process.env.DATABASE_URL_NEW }, // postgres user (bypass RLS para seed cross-tenant)
  pool: { min: 1, max: 5 },
});

const report = { tables: [], totals: { read: 0, inserted: 0, skipped: 0, errors: 0 }, errors: [] };

function log(msg) {
  console.log(msg);
}

// Normaliza role_name legacy → nuevo snake_case
function normalizeRoleName(name) {
  if (!name) return name;
  const map = {
    'Jefe_M': 'jefe_marketing',
    'supervisor_v': 'supervisor_ventas',
  };
  return map[name] || name.toLowerCase();
}

// Helper: ejecuta query INSERT con tenant context para que WITH CHECK pase aunque
// el rol postgres bypass RLS por SELECT. Es defensivo.
async function insertWithContext(trx, table, rows, conflictKeys = ['id']) {
  if (rows.length === 0) return 0;
  await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
  const result = await trx(table)
    .insert(rows)
    .onConflict(conflictKeys)
    .ignore()
    .returning('id');
  return result.length;
}

async function migrateTable(name, fn) {
  if (ONLY && ONLY !== name) return;
  const entry = { name, read: 0, inserted: 0, skipped: 0, error: null };
  try {
    const t0 = Date.now();
    await fn(entry);
    entry.ms = Date.now() - t0;
    report.tables.push(entry);
    report.totals.read += entry.read;
    report.totals.inserted += entry.inserted;
    report.totals.skipped += entry.skipped;
    log(`  ✓ ${name.padEnd(30)} read: ${String(entry.read).padStart(4)} | inserted: ${String(entry.inserted).padStart(4)} | skipped: ${String(entry.skipped).padStart(4)} | ${entry.ms}ms`);
  } catch (err) {
    entry.error = err.message;
    report.tables.push(entry);
    report.totals.errors++;
    report.errors.push({ table: name, error: err.message });
    log(`  ✗ ${name.padEnd(30)} ERROR: ${err.message.split('\n')[0]}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MIGRACIONES POR TABLA
// ═══════════════════════════════════════════════════════════════════════════

async function migrateZones(entry) {
  const rows = await legacy('zones').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    const mapped = rows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      name: r.name,
      orden: r.orden || 0,
      created_at: r.created_at || new Date(),
    }));
    entry.inserted = await insertWithContext(trx, 'zones', mapped);
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateCatalogs(entry) {
  const rows = await legacy('catalogs').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    // Pre-check: cuáles parent_ids del legacy existen como catalog IDs reales.
    // Cualquier parent_id huérfano se setea a null (defensivo).
    const allLegacyIds = new Set(rows.map((r) => r.id));
    const sanitize = (r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      catalog_id: r.catalog_id,
      value: r.value,
      orden: r.orden || 0,
      puntuacion: r.puntuacion != null ? r.puntuacion : 0,
      icono: r.icono || null,
      parent_id: r.parent_id && allLegacyIds.has(r.parent_id) ? r.parent_id : null,
      created_at: r.created_at || new Date(),
    });
    // Pasadas topológicas: en cada pass, insertar rows cuyo parent_id sea NULL
    // o ya esté inserted (in newdb o en pass anterior).
    const pending = new Map(rows.map((r) => [r.id, sanitize(r)]));
    const insertedIds = new Set();
    for (let pass = 0; pass < 10 && pending.size > 0; pass++) {
      const ready = [...pending.values()].filter(
        (r) => !r.parent_id || insertedIds.has(r.parent_id),
      );
      if (ready.length === 0) {
        // Quedan rows sin poder insertar — los ignoramos
        break;
      }
      const count = await insertWithContext(trx, 'catalogs', ready);
      entry.inserted += count;
      ready.forEach((r) => {
        insertedIds.add(r.id);
        pending.delete(r.id);
      });
    }
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateRolePermissions(entry) {
  const rows = await legacy('role_permissions').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    const mapped = rows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      role_name: normalizeRoleName(r.role_name),
      permissions: JSON.stringify(r.permissions || {}),
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
    }));
    // Conflict por (tenant_id, role_name) porque el seed ya insertó los canónicos
    entry.inserted = await insertWithContext(trx, 'role_permissions', mapped, ['tenant_id', 'role_name']);
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateUsers(entry) {
  const rows = await legacy('users').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    const mapped = rows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      username: r.username,
      password_hash: r.password_hash,
      nombre: r.nombre || null,
      zona_id: r.zona_id || null,
      role_name: normalizeRoleName(r.role_name),
      supervisor_id: r.supervisor_id || null,
      activo: r.activo !== false,
      meta_puntos: r.meta_puntos != null ? r.meta_puntos : 5000,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
    }));
    entry.inserted = await insertWithContext(trx, 'users', mapped, ['tenant_id', 'username']);
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateBrands(entry) {
  const rows = await legacy('brands').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    const mapped = rows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      nombre: r.nombre,
      activo: r.activo !== false,
      orden: r.orden || 0,
    }));
    entry.inserted = await insertWithContext(trx, 'brands', mapped, ['tenant_id', 'nombre']);
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateProducts(entry) {
  const rows = await legacy('products').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    // Tomar brand_ids existentes en nueva DB para validar FK
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
    const validBrandIds = new Set((await trx('brands').select('id')).map((b) => b.id));
    const validRows = rows.filter((r) => r.brand_id && validBrandIds.has(r.brand_id));
    if (validRows.length < rows.length) {
      entry.skipped += rows.length - validRows.length;
    }
    const mapped = validRows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      brand_id: r.brand_id,
      nombre: r.nombre,
      activo: r.activo !== false,
      orden: r.orden || 0,
      puntuacion: r.puntuacion != null ? r.puntuacion : 0,
    }));
    entry.inserted = await insertWithContext(trx, 'products', mapped, ['tenant_id', 'brand_id', 'nombre']);
    entry.skipped += validRows.length - entry.inserted;
  });
}

async function migrateStores(entry) {
  const rows = await legacy('stores').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
    const validZoneIds = new Set((await trx('zones').select('id')).map((z) => z.id));
    const validCatalogIds = new Set((await trx('catalogs').select('id')).map((c) => c.id));
    const mapped = rows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      nombre: r.nombre,
      direccion: r.direccion || null,
      zona_id: r.zona_id && validZoneIds.has(r.zona_id) ? r.zona_id : null,
      ruta_id: r.ruta_id && validCatalogIds.has(r.ruta_id) ? r.ruta_id : null,
      latitud: r.latitud != null ? r.latitud : null,
      longitud: r.longitud != null ? r.longitud : null,
      activo: r.activo !== false,
      exhibiciones_esperadas: r.exhibiciones_esperadas != null ? r.exhibiciones_esperadas : 5,
      created_at: r.created_at || new Date(),
    }));
    entry.inserted = await insertWithContext(trx, 'stores', mapped);
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateDailyAssignments(entry) {
  const rows = await legacy('daily_assignments').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
    const validUserIds = new Set((await trx('users').select('id')).map((u) => u.id));
    const validCatalogIds = new Set((await trx('catalogs').select('id')).map((c) => c.id));
    const validRows = rows.filter((r) => validUserIds.has(r.user_id) && validCatalogIds.has(r.route_id));
    if (validRows.length < rows.length) {
      entry.skipped += rows.length - validRows.length;
    }
    const mapped = validRows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      user_id: r.user_id,
      route_id: r.route_id,
      assigned_by: r.assigned_by && validUserIds.has(r.assigned_by) ? r.assigned_by : null,
      day_of_week: r.day_of_week,
      status: r.status || 'pendiente',
      created_at: r.created_at || new Date(),
    }));
    entry.inserted = await insertWithContext(trx, 'daily_assignments', mapped, ['tenant_id', 'user_id', 'day_of_week']);
    entry.skipped += validRows.length - entry.inserted;
  });
}

async function migrateScoringConfigVersions(entry) {
  const rows = await legacy('scoring_config_versions').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    const mapped = rows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      version: r.version,
      fecha_inicio: r.fecha_inicio,
      fecha_fin: r.fecha_fin || null,
      notas: r.notas || null,
      score_maximo: r.score_maximo != null ? r.score_maximo : null,
      score_maximo_calculado_at: r.score_maximo_calculado_at || null,
      created_at: r.created_at || new Date(),
    }));
    entry.inserted = await insertWithContext(trx, 'scoring_config_versions', mapped, ['tenant_id', 'version']);
    entry.skipped = entry.read - entry.inserted;
  });
}

async function migrateScoringWeights(entry) {
  // Legacy table: scoring_pesos → new: scoring_weights
  const rows = await legacy('scoring_pesos').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
    const validVersionIds = new Set((await trx('scoring_config_versions').select('id')).map((v) => v.id));
    const validRows = rows.filter((r) => validVersionIds.has(r.config_version_id));
    if (validRows.length < rows.length) entry.skipped += rows.length - validRows.length;
    const mapped = validRows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      config_version_id: r.config_version_id,
      tipo: r.tipo,
      nombre: r.nombre,
      valor: r.valor,
      created_at: r.created_at || new Date(),
    }));
    entry.inserted = await insertWithContext(trx, 'scoring_weights', mapped, ['tenant_id', 'config_version_id', 'tipo', 'nombre']);
    entry.skipped += validRows.length - entry.inserted;
  });
}

async function migrateDailyCaptures(entry) {
  const rows = await legacy('daily_captures').select('*');
  entry.read = rows.length;
  if (DRY) return;
  await newdb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
    const validUserIds = new Set((await trx('users').select('id')).map((u) => u.id));
    const validStoreIds = new Set((await trx('stores').select('id')).map((s) => s.id));
    const validVersionIds = new Set((await trx('scoring_config_versions').select('id')).map((v) => v.id));

    // Filtrar capturas sin user válido (no se pueden migrar)
    const validRows = rows.filter((r) => validUserIds.has(r.user_id));
    if (validRows.length < rows.length) entry.skipped += rows.length - validRows.length;

    const mapped = validRows.map((r) => ({
      id: r.id,
      tenant_id: TENANT_ID,
      folio: r.folio,
      user_id: r.user_id,
      store_id: r.store_id && validStoreIds.has(r.store_id) ? r.store_id : null,
      fecha: r.fecha,
      hora_inicio: r.hora_inicio,
      hora_fin: r.hora_fin,
      // JSONB explícitamente serializado — sin esto pg falla en algunos shapes
      exhibiciones: JSON.stringify(r.exhibiciones || []),
      stats: JSON.stringify(r.stats || {}),
      latitud: r.latitud != null ? r.latitud : null,
      longitud: r.longitud != null ? r.longitud : null,
      config_version_id: r.config_version_id && validVersionIds.has(r.config_version_id) ? r.config_version_id : null,
      score_maximo: r.score_maximo != null ? r.score_maximo : null,
      score_calidad_pct: r.score_calidad_pct != null ? r.score_calidad_pct : null,
      score_cobertura_pct: r.score_cobertura_pct != null ? r.score_cobertura_pct : null,
      score_final_pct: r.score_final_pct != null ? r.score_final_pct : null,
      created_at: r.created_at || new Date(),
    }));

    // Insert en batches de 100 para no superar límites de pg
    const BATCH = 100;
    for (let i = 0; i < mapped.length; i += BATCH) {
      const batch = mapped.slice(i, i + BATCH);
      entry.inserted += await insertWithContext(trx, 'daily_captures', batch, ['tenant_id', 'folio']);
    }
    entry.skipped += validRows.length - entry.inserted;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  console.log(`\n═══ Migración legacy → nueva DB ${DRY ? '(DRY RUN)' : '(REAL)'} ═══`);
  console.log(`Tenant destino: ${TENANT_ID} (Mega Dulces)`);
  if (ONLY) console.log(`Solo tabla: ${ONLY}`);
  console.log('');

  try {
    await migrateTable('zones', migrateZones);
    await migrateTable('catalogs', migrateCatalogs);
    await migrateTable('role_permissions', migrateRolePermissions);
    await migrateTable('users', migrateUsers);
    await migrateTable('brands', migrateBrands);
    await migrateTable('products', migrateProducts);
    await migrateTable('stores', migrateStores);
    await migrateTable('daily_assignments', migrateDailyAssignments);
    await migrateTable('scoring_config_versions', migrateScoringConfigVersions);
    await migrateTable('scoring_weights', migrateScoringWeights);
    await migrateTable('daily_captures', migrateDailyCaptures);

    console.log('\n═══ Resumen ═══');
    console.log(`  Total read:     ${report.totals.read}`);
    console.log(`  Total inserted: ${report.totals.inserted}`);
    console.log(`  Total skipped:  ${report.totals.skipped} (ya existían o FK inválida)`);
    console.log(`  Errores:        ${report.totals.errors}`);

    if (report.errors.length > 0) {
      console.log('\n═══ Errores ═══');
      report.errors.forEach((e) => console.log(`  ✗ ${e.table}: ${e.error}`));
      process.exit(1);
    }

    if (DRY) {
      console.log('\n(DRY RUN — no se escribió nada. Re-ejecutar sin --dry-run para aplicar.)');
    }
  } catch (err) {
    console.error('\n✗ Excepción fatal:', err.message);
    console.error(err.stack);
    process.exit(2);
  } finally {
    await legacy.destroy();
    await newdb.destroy();
  }
})();
