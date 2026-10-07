/**
 * Seed inicial: Mega Dulces como primer tenant de la plataforma.
 *
 * UUID hardcodeado para reproducibilidad — sirve como FK estable en seeds
 * posteriores (usuarios, zonas, stores, etc. de Mega Dulces).
 *
 * Idempotente: ON CONFLICT (slug) DO NOTHING para no duplicar en reseeds.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c'; // "d01c" = mock identifier
  await knex('tenants')
    .insert({
      id: MEGA_DULCES_TENANT_ID,
      slug: 'mega_dulces',
      nombre: 'Mega Dulces',
      activo: true,
      plan: 'enterprise',
      metadata: JSON.stringify({
        legacy_db_source: true,
        zona_principal: 'la_piedad',
        notas: 'Primer tenant de la plataforma. Migrado desde DB legacy en Sprint A.0mt.4.',
      }),
    })
    .onConflict('slug')
    .ignore();

  console.log(`[01_first_tenant_mega_dulces] Tenant 'mega_dulces' (${MEGA_DULCES_TENANT_ID}) seeded.`);
};
