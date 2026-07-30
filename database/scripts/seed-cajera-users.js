/**
 * SM.9 — Genera usuarios `cajera` a partir de los cortes de caja recientes, para
 * que /tienda/arqueo se autocomplete (sucursal por login + cajero por username).
 *
 * Fuente de verdad: las cajeras que aparecen en `analytics.cash_cuts` en las
 * últimas 2 semanas (relativas al último corte cargado), con su nombre de
 * `analytics.pos_cashiers`.
 *
 * Convención (decidida 2026-07-30):
 *   - username = código de caja en minúsculas (ej. 10C01 → "10c01").
 *   - password = el MISMO string (usuario y contraseña iguales, fácil de comunicar).
 *   - role_name = 'cajera' (mínimo privilegio; ver mig 20260730140000).
 *   - warehouse_code = su sucursal (si el código vive en 1 sola; si opera en varias,
 *     queda NULL y elige sucursal a mano).
 *
 * Idempotente: si el username ya existe (por tenant), lo salta. Re-ejecutable.
 * RLS forzado en identity.users → SET LOCAL app.tenant_id.
 *
 * Uso:  node database/scripts/seed-cajera-users.js            (dry-run: solo lista)
 *       node database/scripts/seed-cajera-users.js --apply    (crea los usuarios)
 */
const path = require('path');
const bcrypt = require('bcryptjs');
const cfg = require(path.join(__dirname, '..', 'knexfile-newdb.js'));
const knex = require('knex')(cfg.development || cfg);

const TENANT_ID = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const WINDOW_DAYS = 14;
const APPLY = process.argv.includes('--apply');

(async () => {
  const mx = await knex('analytics.cash_cuts').where('tenant_id', TENANT_ID).max('business_date as m').first();
  if (!mx?.m) { console.log('No hay cortes de caja. Nada que sembrar.'); await knex.destroy(); return; }
  const maxD = new Date(mx.m);
  const from = new Date(maxD); from.setDate(from.getDate() - (WINDOW_DAYS - 1));
  const fromS = from.toISOString().slice(0, 10);
  const toS = maxD.toISOString().slice(0, 10);
  console.log(`Ventana: ${fromS} → ${toS} (${WINDOW_DAYS} días desde el último corte)`);

  const rows = await knex('analytics.cash_cuts as cc').where('cc.tenant_id', TENANT_ID)
    .whereNotNull('cc.cajero_cierre').where('cc.business_date', '>=', fromS)
    .leftJoin('analytics.pos_cashiers as pc', function () {
      this.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre');
    })
    .groupBy('cc.warehouse_code', 'cc.cajero_cierre', 'pc.nombre')
    .select('cc.warehouse_code', 'cc.cajero_cierre', knex.raw('pc.nombre AS nombre'), knex.raw('COUNT(*)::int AS cortes'));

  // Agrupa por username (= código en minúsculas). Un código puede aparecer en >1 sucursal.
  const byUser = new Map();
  for (const r of rows) {
    const code = String(r.cajero_cierre).trim();
    const username = code.toLowerCase();
    let u = byUser.get(username);
    if (!u) { u = { username, code, nombre: r.nombre || null, warehouses: new Map() }; byUser.set(username, u); }
    if (!u.nombre && r.nombre) u.nombre = r.nombre;
    u.warehouses.set(r.warehouse_code, (u.warehouses.get(r.warehouse_code) || 0) + Number(r.cortes));
  }

  const plan = [...byUser.values()].map((u) => {
    const whs = [...u.warehouses.keys()];
    const warehouse_code = whs.length === 1 ? whs[0] : null; // multi-sucursal → elige a mano
    return { username: u.username, code: u.code, nombre: u.nombre, warehouse_code, sucursales: whs.join('/') };
  }).sort((a, b) => (a.sucursales || '').localeCompare(b.sucursales || '') || a.username.localeCompare(b.username));

  // ¿Cuáles ya existen?
  const existing = new Set(
    (await knex('identity.users').where('tenant_id', TENANT_ID).whereIn('username', plan.map((p) => p.username)).select('username'))
      .map((r) => r.username),
  );

  console.log(`\n${plan.length} cajeras distintas · ${existing.size} ya con usuario · ${plan.length - existing.size} a crear\n`);
  console.log('SUC   USUARIO        CONTRASEÑA     NOMBRE                                 ESTADO');
  for (const p of plan) {
    const status = existing.has(p.username) ? 'existe (skip)' : (APPLY ? 'CREADO' : 'a crear');
    console.log(
      `${(p.warehouse_code || p.sucursales).padEnd(5)} ${p.username.padEnd(14)} ${p.username.padEnd(14)} ${(p.nombre || '(sin nombre)').padEnd(38)} ${status}`,
    );
  }

  if (!APPLY) { console.log('\nDRY-RUN. Corré con --apply para crear los usuarios.'); await knex.destroy(); return; }

  let created = 0;
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
    for (const p of plan) {
      if (existing.has(p.username)) continue;
      const password_hash = await bcrypt.hash(p.username, 10); // password = username (= código en minúsculas)
      await trx('identity.users')
        .insert({
          tenant_id: TENANT_ID, username: p.username, password_hash,
          nombre: p.nombre || p.code, role_name: 'cajera', warehouse_code: p.warehouse_code, activo: true,
        })
        .onConflict(['tenant_id', 'username']).ignore();
      created++;
    }
  });
  console.log(`\n✅ ${created} usuario(s) cajera creado(s). Usuario y contraseña = código de caja en minúsculas.`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
