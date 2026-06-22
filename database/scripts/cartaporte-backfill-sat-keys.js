/**
 * J12.0 (C) — Backfill de claves SAT en catalog.products para Carta Porte 3.1.
 *
 *   sat_clave_prod_serv  ← por `department` (fallback dulces para NULL/desconocido)
 *   sat_clave_unidad     ← por `unit_sale`  (fallback H87 = Pieza)
 *   sat_material_peligroso ← false (dulces/abarrotes; ya es default)
 *
 * Idempotente: solo escribe donde la columna está NULL (respeta overrides manuales).
 * Dry-run por DEFAULT. Para aplicar: `node cartaporte-backfill-sat-keys.js --apply`
 *
 * ⚠️ Las claves ClaveProdServ son una APROXIMACIÓN por categoría. El contador de
 *    Mega Dulces debe validar/ajustar los códigos finales (sobre todo desechables,
 *    abarrotes y materias primas). El mecanismo es lo importante: re-correr es seguro.
 *
 * Conexión: DATABASE_URL_NEW (.env) o default localhost:5433. Tenant: mega_dulces.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const CONN =
  process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.CP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// department → ClaveProdServ SAT (c_ClaveProdServ). Aproximación por categoría.
const DEPT_TO_CLAVE = {
  DULCES: '50181900',                       // Confitería / dulces
  BOTANAS: '50192100',                      // Bocadillos / botanas
  BEBIDAS: '50202300',                      // Bebidas no alcohólicas
  ABARROTES: '50000000',                    // Alimentos, bebidas y tabaco (genérico)
  'MATERIAS PRIMAS REPOSTERIA': '50000000', // Insumos de alimentos
  DESECHABLES: '24122000',                  // Materiales de empaque desechables
  'ARTICULOS DE FIESTAS': '60141100',       // Artículos para fiestas
  'ARTICULOS DE LIMPIEZA HOGAR': '47131800',// Productos de limpieza
  'PRODUCTO DE HIGIENE PERSONAL': '53131600',// Higiene personal
};
const DEFAULT_CLAVE_PROD = '50181900'; // fallback dulces (giro principal)

// unit_sale → ClaveUnidad SAT (c_ClaveUnidad)
const UNIT_TO_CLAVE = {
  PZA: 'H87', // Pieza
  CJA: 'XBX', // Caja
  KGS: 'KGM', // Kilogramo
  PAQ: 'XPK', // Paquete
  SER: 'E48', // Unidad de servicio
};
const DEFAULT_CLAVE_UNIDAD = 'H87';

(async () => {
  const knex = knexLib({ client: 'pg', connection: CONN, pool: { min: 1, max: 2 } });
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔎 DRY-RUN (usa --apply para escribir)'} · tenant ${TENANT}\n`);

  // Resumen previo
  const [{ total, sin_clave }] = (
    await knex.raw(
      `SELECT count(*)::int total, count(*) FILTER (WHERE sat_clave_prod_serv IS NULL)::int sin_clave
         FROM catalog.products WHERE tenant_id=? AND deleted_at IS NULL`, [TENANT])
  ).rows;
  console.log(`Productos: ${total} · sin clave hoy: ${sin_clave}`);

  // Preview por department
  const preview = (
    await knex.raw(
      `SELECT COALESCE(department,'(null)') dep, count(*)::int n
         FROM catalog.products WHERE tenant_id=? AND deleted_at IS NULL AND sat_clave_prod_serv IS NULL
        GROUP BY department ORDER BY n DESC`, [TENANT])
  ).rows;
  console.log('\nClaveProdServ que se asignaría por department:');
  preview.forEach((r) => {
    const clave = DEPT_TO_CLAVE[r.dep] || DEFAULT_CLAVE_PROD;
    console.log(`  ${r.dep.padEnd(32)} → ${clave}  (${r.n})`);
  });

  if (!APPLY) { console.log('\nDry-run: nada escrito.\n'); await knex.destroy(); return; }

  let prodUpdated = 0;
  // ClaveProdServ por department (solo donde NULL)
  for (const [dep, clave] of Object.entries(DEPT_TO_CLAVE)) {
    const r = await knex.raw(
      `UPDATE catalog.products SET sat_clave_prod_serv=?, updated_at=now()
         WHERE tenant_id=? AND deleted_at IS NULL AND department=? AND sat_clave_prod_serv IS NULL`,
      [clave, TENANT, dep]);
    prodUpdated += r.rowCount || 0;
  }
  // Fallback para el resto (department NULL o no mapeado)
  const rFall = await knex.raw(
    `UPDATE catalog.products SET sat_clave_prod_serv=?, updated_at=now()
       WHERE tenant_id=? AND deleted_at IS NULL AND sat_clave_prod_serv IS NULL`,
    [DEFAULT_CLAVE_PROD, TENANT]);
  prodUpdated += rFall.rowCount || 0;

  let unitUpdated = 0;
  for (const [unit, clave] of Object.entries(UNIT_TO_CLAVE)) {
    const r = await knex.raw(
      `UPDATE catalog.products SET sat_clave_unidad=?, updated_at=now()
         WHERE tenant_id=? AND deleted_at IS NULL AND unit_sale=? AND sat_clave_unidad IS NULL`,
      [clave, TENANT, unit]);
    unitUpdated += r.rowCount || 0;
  }
  const rUFall = await knex.raw(
    `UPDATE catalog.products SET sat_clave_unidad=?, updated_at=now()
       WHERE tenant_id=? AND deleted_at IS NULL AND sat_clave_unidad IS NULL`,
    [DEFAULT_CLAVE_UNIDAD, TENANT]);
  unitUpdated += rUFall.rowCount || 0;

  console.log(`\n✅ ClaveProdServ asignada a ${prodUpdated} productos · ClaveUnidad a ${unitUpdated}.`);
  await knex.destroy();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
