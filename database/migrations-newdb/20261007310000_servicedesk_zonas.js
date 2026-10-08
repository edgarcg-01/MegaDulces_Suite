'use strict';
/**
 * `[MS.7.3]` — Zonas: el LUGAR dentro de la ubicación. `FASE_MS7_MANTENIMIENTO.md` (decisión M7).
 *
 * La ubicación de un ticket es DÓNDE (una sucursal, las oficinas, el estacionamiento del CEDIS); la zona es EN QUÉ parte de ese
 * sitio (bodega, andén, oficina, baños, exterior). No es parte de la ubicación: la misma zona se repite en todos los sitios, y por
 * eso es un catálogo propio y no un sufijo del código de ubicación.
 *
 * ── Qué agrega ────────────────────────────────────────────────────────────────────────────────
 * · `servicedesk.zones` — el catálogo (código, nombre, orden, activa). Se edita desde pantalla; apagar no borra (los tickets viejos
 *   la conservan).
 * · `requests.zone_code` — la zona del ticket (opcional), con FK compuesta al catálogo: no hay zonas inventadas.
 * · `queues.asks_zone` — si el formulario de esa cola PREGUNTA la zona. Se elige por este VALOR (nunca por el nombre de la cola);
 *   nace en `false` (TI no cambia) y se enciende en Mantenimiento.
 *
 * ── Siembra ──────────────────────────────────────────────────────────────────────────────────
 * Las 5 zonas del plan: bodega, andén, oficina, baños, exterior. Ninguna otra: no se inventan; la coordinación suma las que falten.
 *
 * Aditiva, idempotente y reversible. RLS forzado + grants por tabla a `app_runtime`.
 *
 * @param { import("knex").Knex } knex
 */

const ZONAS = [
  ['bodega', 'Bodega', 10],
  ['anden', 'Andén', 20],
  ['oficina', 'Oficina', 30],
  ['banos', 'Baños', 40],
  ['exterior', 'Exterior', 50],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.zones (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      code        text        NOT NULL,
      name        text        NOT NULL,
      sort_order  integer     NOT NULL DEFAULT 100,
      active      boolean     NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid,
      PRIMARY KEY (id),
      CONSTRAINT zones_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT zones_code_uk UNIQUE (tenant_id, code),
      CONSTRAINT zones_code_ck CHECK (code ~ '^[a-z][a-z0-9_]{0,29}$'),
      CONSTRAINT zones_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 60)
    )`);
  await knex.raw(`ALTER TABLE servicedesk.zones ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.zones FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.zones`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.zones
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON servicedesk.zones TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE servicedesk.zones IS 'MS.7.3 — el LUGAR dentro de la ubicación (bodega, andén, oficina, baños, exterior). Catálogo editable; apagar no borra (los tickets viejos la conservan).'`);

  const tieneZona = await knex.schema.withSchema('servicedesk').hasColumn('requests', 'zone_code');
  if (!tieneZona) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN zone_code varchar(30)`);
    await knex.raw(`
      ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_zone_fk
        FOREIGN KEY (tenant_id, zone_code) REFERENCES servicedesk.zones (tenant_id, code) ON DELETE RESTRICT`);
  }
  const tienePregunta = await knex.schema.withSchema('servicedesk').hasColumn('queues', 'asks_zone');
  if (!tienePregunta) await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN asks_zone boolean NOT NULL DEFAULT false`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.zone_code IS 'MS.7.3 — la zona del ticket (opcional). NULL = no se indicó / la cola no la pregunta.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.asks_zone IS 'MS.7.3 — si el formulario de esta cola PREGUNTA la zona. Se elige por este valor, nunca por el nombre de la cola.'`);

  // Siembra, por tenant que ya tiene la Mesa.
  const tenants = await knex('servicedesk.settings').pluck('tenant_id');
  let nuevas = 0;
  for (const tenant of tenants) {
    for (const [code, name, orden] of ZONAS) {
      const r = await knex.raw(
        `INSERT INTO servicedesk.zones (tenant_id, code, name, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenant, code, name, orden],
      );
      nuevas += r.rowCount ?? 0;
    }
  }
  // Mantenimiento pregunta la zona (si está sembrada y nadie le cambió nada).
  const m = await knex.raw(`UPDATE servicedesk.queues SET asks_zone = true, updated_at = now() WHERE code = 'mantenimiento' AND asks_zone = false AND deleted_at IS NULL`);
  // eslint-disable-next-line no-console
  console.log(`  [MS.7.3] zones creada · requests.zone_code ${tieneZona ? 'ya existía' : 'agregada'} · queues.asks_zone ${tienePregunta ? 'ya existía' : 'agregada'} · ${nuevas} zona(s) nueva(s) · Mantenimiento pregunta la zona: ${m.rowCount ?? 0}`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_zone_fk`);
  await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS zone_code`);
  await knex.raw(`ALTER TABLE servicedesk.queues DROP COLUMN IF EXISTS asks_zone`);
  await knex.raw('DROP TABLE IF EXISTS servicedesk.zones');
};
