'use strict';
/**
 * `[COT.55]` — «Solo precio 1 (sin mayoreo)»: ciertas cotizaciones se cobran al precio de lista
 * de la presentación, sin el precio por volumen del ERP (`kdpv_prod_util`).
 *
 * Pedido de Edgar (2026-11-23): «un botón de configuración para que ciertos pedidos solamente pasen
 * con precio 1, sin precio de mayoreo». Decisiones suyas, ese día:
 *   · DÓNDE: las dos — el cliente trae el valor por defecto y en cada cotización se puede cambiar.
 *   · QUÉ QUITA: sólo el mayoreo (volumen). Las promociones y el % del cliente se siguen aplicando.
 *   · QUIÉN: con permiso — supervisor, supervisor_ventas, direccion y superadmin.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-23) ────────────────────────────────────────
 *  · El maestro de clientes de Kepler (`kdud`, 31 columnas, todas decodificadas en ERP_KEPLER.md)
 *    NO tiene nivel de precio ni «sin mayoreo»: el valor por cliente no se puede DERIVAR, es dato
 *    propio de la Suite (regla 1: tabla real sólo para datos propios).
 *  · `commercial.customers` cubre 4 de los 259 clientes cotizados en 60 días: no sirve de ancla.
 *    La llave es la de Kepler, (sucursal, clave del cliente), la misma que guarda la cotización.
 *  · `commercial.price_lists` (P1–P4, MAYOREO) está RETIRADA desde NORM.1 (su importer murió):
 *    no se reusa.
 *  · Hoy 46 % de los renglones cotizados salen con precio por volumen (COT.47, 30 días).
 *
 * `commercial.quotes.list_price_only` nace `NOT NULL DEFAULT false`: el código desplegado no lo
 * manda y todas sus inserciones caen en el default (compatible con la API vieja).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[cot55_precio_1_sin_mayoreo]';
const LLAVE = 'COMMERCIAL_QUOTES_PRECIO_LISTA';
const ROLES = ['supervisor', 'supervisor_ventas', 'direccion', 'superadmin'];
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La cotización recuerda si va sólo a precio 1 ───────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasColumn('quotes', 'list_price_only'))) {
    await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN list_price_only boolean NOT NULL DEFAULT false`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.quotes.list_price_only IS
    'COT.55 — true: los renglones se cobran a precio de lista (precio 1), sin el precio por volumen del ERP. Promociones y % del cliente sí aplican. Nace del valor del cliente (commercial.customer_pricing_prefs) y lo cambia quien tiene COMMERCIAL_QUOTES_PRECIO_LISTA.'`);

  // ── 2. El valor por defecto de cada cliente de Kepler (dato propio) ───────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.customer_pricing_prefs (
      id                 uuid         NOT NULL DEFAULT gen_random_uuid(),
      tenant_id          uuid         NOT NULL,
      branch             varchar(4)   NOT NULL,
      erp_customer_code  varchar(20)  NOT NULL,
      list_price_only    boolean      NOT NULL DEFAULT false,
      created_at         timestamptz  NOT NULL DEFAULT now(),
      created_by         uuid,
      updated_at         timestamptz  NOT NULL DEFAULT now(),
      updated_by         uuid,
      deleted_at         timestamptz,
      deleted_by         uuid,
      CONSTRAINT customer_pricing_prefs_pkey PRIMARY KEY (id),
      -- ⚠️ identity.tenants, NO public.tenants (ésa es una vista; ver ALC.0.4).
      CONSTRAINT customer_pricing_prefs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_pricing_prefs_cliente
    ON commercial.customer_pricing_prefs (tenant_id, branch, erp_customer_code) WHERE deleted_at IS NULL`);
  await knex.raw(`ALTER TABLE commercial.customer_pricing_prefs ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.customer_pricing_prefs FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.customer_pricing_prefs`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.customer_pricing_prefs
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin DELETE: apagarlo es list_price_only = false, y queda quién y cuándo.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.customer_pricing_prefs TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE commercial.customer_pricing_prefs IS
    'COT.55 — preferencias de precio por cliente de Kepler (sucursal, clave kdud): hoy sólo «solo precio 1, sin mayoreo». Dato propio: kdud no tiene nivel de precio. El maestro de clientes NO se copia.'`);

  // ── 3. Reparto de la llave (regla 20) ─────────────────────────────────────────────────────
  const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, (role_name IN (${marcas(ROLES)})))
      WHERE permissions -> ?::text IS NULL
        AND role_name NOT LIKE 'retirado%'
        AND deleted_at IS NULL`,
    [LLAVE, ...ROLES, LLAVE],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL
      ORDER BY 1`,
    [LLAVE],
  );
  if (hay.n > 0 && !rows.length) {
    throw new Error(`${TAG} Ningún rol (fuera de superadmin) quedó con ${LLAVE}: nadie podría moverlo (regla 20)`);
  }
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la columna, la tabla y la llave son nuevas. */
exports.down = async function down(knex) {
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`DROP TABLE IF EXISTS commercial.customer_pricing_prefs`);
  await knex.raw(`ALTER TABLE commercial.quotes DROP COLUMN IF EXISTS list_price_only`);
};
