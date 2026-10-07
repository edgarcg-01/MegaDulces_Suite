/**
 * Fase FIQ.0 (ADR-036) — Identidad del contacto por teléfono.
 *
 * Raíz del bot 10x: hoy el bot nunca reconoce al cliente (thread.customer_id
 * siempre null) porque el teléfono de Meta (`521XXXXXXXXXX`) no matchea contra
 * `commercial.customers.whatsapp` (`+52...`). Esta migración da:
 *
 *  1. `public.mx_normalize_phone(text)` — canónico `52XXXXXXXXXX` (espejo EXACTO
 *     del util TS `normalizeMxPhone`). IMMUTABLE para poder indexarla.
 *  2. Índices FUNCIONALES en `commercial.customers` sobre el teléfono normalizado
 *     (whatsapp y phone). NO se muta la columna `whatsapp` (cero riesgo en prod);
 *     el lookup normaliza ambos lados con la misma función.
 *  3. `whatsapp.phone_number_tenant_map` — routing multi-tenant real
 *     (phone_number_id de Meta → tenant_id), reemplaza el WHATSAPP_TENANT_ID
 *     hardcodeado. Tabla GLOBAL admin-managed (se consulta ANTES de tener scope
 *     de tenant → sin RLS, patrón chicken-egg como public.route_location_pings).
 *  4. Log de cobertura: cuántos customers tienen un teléfono que normaliza a un
 *     MSISDN MX válido (observabilidad — la parte frágil del sprint, ver crítica).
 *
 * Idempotente. No destructiva.
 */

exports.up = async function up(knex) {
  // 1) Función canónica de normalización MX (espejo de normalizeMxPhone en TS).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.mx_normalize_phone(input text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    AS $fn$
      SELECT CASE
        WHEN x.d IS NULL OR x.d = '' THEN NULL
        WHEN length(x.d) = 10 THEN '52' || x.d
        WHEN length(x.d) = 12 AND left(x.d, 2) = '52' THEN x.d
        WHEN length(x.d) = 13 AND left(x.d, 3) = '521' THEN '52' || substr(x.d, 4)
        ELSE x.d
      END
      FROM (
        SELECT regexp_replace(
                 regexp_replace(coalesce(input, ''), '[^0-9]', '', 'g'),
                 '^00', ''
               ) AS d
      ) x;
    $fn$;
  `);

  // 2) Índices funcionales para lookup rápido por teléfono normalizado (sin mutar datos).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_customers_whatsapp_norm
      ON commercial.customers (tenant_id, public.mx_normalize_phone(whatsapp))
      WHERE whatsapp IS NOT NULL AND deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_customers_phone_norm
      ON commercial.customers (tenant_id, public.mx_normalize_phone(phone))
      WHERE phone IS NOT NULL AND deleted_at IS NULL
  `);

  // 3) Mapeo phone_number_id (Meta) → tenant_id. Tabla global (sin RLS).
  if (!(await knex.schema.withSchema('whatsapp').hasTable('phone_number_tenant_map'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.phone_number_tenant_map (
        phone_number_id  varchar(40) PRIMARY KEY,
        tenant_id        uuid NOT NULL,
        label            varchar(120),
        created_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await knex.raw(`GRANT SELECT ON whatsapp.phone_number_tenant_map TO app_runtime`);
  }

  // Seed del número del piloto (Mega Dulces). ON CONFLICT DO NOTHING = idempotente.
  await knex.raw(
    `INSERT INTO whatsapp.phone_number_tenant_map (phone_number_id, tenant_id, label)
       VALUES (?, ?, ?)
     ON CONFLICT (phone_number_id) DO NOTHING`,
    ['1256572530868591', '00000000-0000-0000-0000-00000000d01c', 'Mega Dulces (número de prueba Meta)'],
  );

  // 4) Log de cobertura (observabilidad — no falla la migración).
  try {
    const cov = await knex.raw(`
      SELECT
        count(*) FILTER (WHERE whatsapp IS NOT NULL) AS con_whatsapp,
        count(*) FILTER (
          WHERE whatsapp IS NOT NULL
            AND length(public.mx_normalize_phone(whatsapp)) = 12
            AND left(public.mx_normalize_phone(whatsapp), 2) = '52'
        ) AS whatsapp_mx_valido,
        count(*) FILTER (WHERE phone IS NOT NULL) AS con_phone,
        count(*) AS total
      FROM commercial.customers
      WHERE deleted_at IS NULL
    `);
    const r = cov.rows?.[0] || {};
    // eslint-disable-next-line no-console
    console.log(
      `[fiq0_phone_identity] cobertura customers: total=${r.total} con_whatsapp=${r.con_whatsapp} whatsapp_mx_valido=${r.whatsapp_mx_valido} con_phone=${r.con_phone}`,
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[fiq0_phone_identity] cobertura no calculable (${e.message}) — no bloquea`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_customers_whatsapp_norm`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_customers_phone_norm`);
  await knex.schema.withSchema('whatsapp').dropTableIfExists('phone_number_tenant_map');
  await knex.raw(`DROP FUNCTION IF EXISTS public.mx_normalize_phone(text)`);
};
