/**
 * DM.11 — Destino del traspaso a sucursal (¿a quién va dirigido?).
 *
 * Un "Traspaso a sucursal" (TrsfShip = U/D/41) que NO tiene recepción pareada solo podía
 * decir "sin recepción" — sin nombrar la sucursal destino, justo lo que se necesita para
 * reclamar quién no ha recepcionado. El destino SÍ existe en el origen: kdm1.c10 (código,
 * ej. 'TI007') resuelto por el catálogo md.kdud (c3 = "TRASPASO ZAMORA CENTRO"). Hoy el
 * feed lo ignoraba.
 *
 *   - stock_movements.dest_code  = kdm1.c10 crudo (solo en TrsfShip; NULL en el resto)
 *   - stock_movements.dest_label = md.kdud.c3 (label legible, resuelto en vivo por el importer)
 *   - analytics.transfer_dest_map = puente CURABLE dest_code → warehouse_id. El importer
 *     auto-descubre (dest_code, dest_label); el warehouse_id se cura acá (seed) y en la UI.
 *     No mapeado ⇒ la UI degrada a solo-label (el nombre igual responde "a quién va").
 *
 * analytics.* sin RLS → tenant_id explícito. Idempotente (hasColumn / IF NOT EXISTS).
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

// Decode de los TI### vistos en CEDIS (md_00) 2026-07-20 → sucursal destino. Los códigos
// de almacén DIFIEREN por entorno (prod usa el nº de servidor Kepler '01'–'05'; local/otros
// usan 'MD-NN' por nº de tienda) → se listan CANDIDATOS en orden de preferencia y se toma el
// primero que exista. El importer refresca dest_label; acá es fallback + enlace a sucursal.
const SEED = [
  ['TI001', 'TRASPASO A SUCURSAL PADRE HIDALGO', ['01', 'MD-10']],
  ['TI002', 'TRASPASO 8 ESQUINAS', ['03', 'MD-40']],
  ['TI003', 'TRASPASO YURECUARO', ['04', 'MD-44']],
  ['TI004', 'TRASPASO MORELIA ABASTOS', ['MD-30', '30']],
  ['TI006', 'TRASPASO ZAMORA CANINDO', ['MD-50', '50']],
  ['TI007', 'TRASPASO ZAMORA CENTRO', ['05', 'MD-54']],
  ['TI008', 'TRASPASO ABASTOS LA PIEDAD', ['02', 'MD-42']],
  ['TI009', 'TRASPASO MORELIA MADERO', ['MD-32', '32']],
];

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // 1) columnas denormalizadas en el feed (self-describing, sin join obligatorio)
  if (await knex.schema.withSchema('analytics').hasTable('stock_movements')) {
    if (!(await knex.schema.withSchema('analytics').hasColumn('stock_movements', 'dest_code'))) {
      await knex.raw(`ALTER TABLE analytics.stock_movements ADD COLUMN dest_code text`);
    }
    if (!(await knex.schema.withSchema('analytics').hasColumn('stock_movements', 'dest_label'))) {
      await knex.raw(`ALTER TABLE analytics.stock_movements ADD COLUMN dest_label text`);
    }
  }

  // 2) puente curable dest_code → warehouse_id
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.transfer_dest_map (
      tenant_id    uuid NOT NULL,
      dest_code    text NOT NULL,
      dest_label   text,
      warehouse_id uuid,                          -- commercial.warehouses.id; NULL = aún sin curar
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, dest_code)
    )`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.transfer_dest_map TO app_runtime`);

  // 3) seed inicial: enlaza los TI### conocidos a su almacén tomando el primer code candidato
  //    que exista en este deploy. Si ninguno existe, warehouse_id queda NULL (la UI muestra
  //    el label igual). Resuelto en JS para no pelear con bindings de array en knex.raw.
  const whs = await knex('commercial.warehouses').where('tenant_id', M).select('id', 'code');
  const byCode = new Map(whs.map((w) => [w.code, w.id]));
  for (const [code, label, candidates] of SEED) {
    const whId = candidates.map((c) => byCode.get(c)).find(Boolean) || null;
    await knex.raw(
      `INSERT INTO analytics.transfer_dest_map (tenant_id, dest_code, dest_label, warehouse_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, dest_code) DO UPDATE
         SET warehouse_id = COALESCE(analytics.transfer_dest_map.warehouse_id, EXCLUDED.warehouse_id),
             dest_label   = COALESCE(analytics.transfer_dest_map.dest_label, EXCLUDED.dest_label),
             updated_at   = now()`,
      [M, code, label, whId],
    );
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.transfer_dest_map`);
  await knex.raw(`ALTER TABLE analytics.stock_movements DROP COLUMN IF EXISTS dest_code`);
  await knex.raw(`ALTER TABLE analytics.stock_movements DROP COLUMN IF EXISTS dest_label`);
};
