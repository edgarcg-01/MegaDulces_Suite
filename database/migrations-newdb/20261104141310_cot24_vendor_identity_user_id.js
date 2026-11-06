'use strict';
/**
 * `[COT.24]` — El vendedor de Kepler que ES cada usuario de la Suite, por sucursal.
 *
 * La cotización pide elegir vendedor cuando el cliente no trae uno en Kepler o es prospecto, y
 * quien cotiza se elige a sí mismo cada vez. Nada guardaba esa liga: `analytics.vendor_identity`
 * ya dice qué PERSONA es cada `(sucursal, código)` de Kepler, pero no qué usuario. Se extiende esa
 * tabla (regla 2: extender, no copiar) con `user_id`.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-04) ────────────────────────────────────────
 *  · En las cotizaciones de la Suite, cada vendedor de telemarketing se elige a sí mismo:
 *    cinthia_valle → 01:10001 en 13 de 15 · alberto_ayala → 08:20003 en 6 de 6 ·
 *    sergio_mendoza → 01:10002 en 3 de 3.
 *  · Y `vendor_identity` ya nombra a esa persona en ese código: 01:10001 «Cinthia Yaret del
 *    Valle Rueda», 01:10002 «Sergio Francisco Mendoza Perez», 08:20003 «Alberto Ayala González».
 *  · Se siembran SÓLO esas tres (dos hechos independientes: su elección y el nombre). Las demás
 *    personas (p. ej. José Ramón 06:30004, Yadira 07/08:20006) sólo coinciden por nombre: quedan
 *    sin liga hasta que alguien la confirme, y la pantalla les sigue pidiendo elegir.
 *
 * Una persona, un código por sucursal: índice único parcial (tenant, user, sucursal).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const LIGAS = [
  { username: 'cinthia_valle', sucursal: '01', vendedor: '10001' },
  { username: 'sergio_mendoza', sucursal: '01', vendedor: '10002' },
  { username: 'alberto_ayala', sucursal: '08', vendedor: '20003' },
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const has = await knex.schema.withSchema('analytics').hasColumn('vendor_identity', 'user_id');
  if (!has) {
    await knex.raw(`ALTER TABLE analytics.vendor_identity ADD COLUMN user_id uuid NULL`);
  }
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_identity_user_branch
       ON analytics.vendor_identity (tenant_id, user_id, source_branch) WHERE user_id IS NOT NULL`,
  );

  let ligadas = 0;
  for (const l of LIGAS) {
    const r = await knex.raw(
      `UPDATE analytics.vendor_identity vi
          SET user_id = u.id, updated_at = now()
         FROM identity.users u
        WHERE u.tenant_id = vi.tenant_id AND u.username = ? AND u.deleted_at IS NULL
          AND vi.tenant_id = ? AND vi.source_branch = ? AND vi.vendedor = ? AND vi.user_id IS NULL`,
      [l.username, TENANT, l.sucursal, l.vendedor],
    );
    ligadas += r.rowCount || 0;
  }
  const total = await knex.raw(`SELECT count(*)::int AS n FROM analytics.vendor_identity WHERE user_id IS NOT NULL`);
  console.log(`[COT.24] ligas sembradas ahora: ${ligadas} (esperado 3 la primera vez) · con usuario en total: ${total.rows[0].n}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ux_vendor_identity_user_branch`);
  const has = await knex.schema.withSchema('analytics').hasColumn('vendor_identity', 'user_id');
  if (has) await knex.raw(`ALTER TABLE analytics.vendor_identity DROP COLUMN user_id`);
};
