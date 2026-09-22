'use strict';
/**
 * `[E.12.1]` — El padrón de mayoreo real, y el alta de cotización que le corresponde.
 *
 * ── El hallazgo que obliga esta migración ───────────────────────────────────────────────────
 * E.12.0 dejó `quotes.customer_id` apuntando a `commercial.customers` y `warehouse_id` NOT NULL
 * contra `commercial.warehouses`. **Con eso no se puede cotizar mayoreo**, y se midió:
 *
 *   · `commercial.customers` tiene 3,239 filas, y **sólo 117 empatan** con un código de
 *     `kepler_ods.kdud` (3.6%). Son otro universo: los códigos son `V-…` (campo), `IMP-…`,
 *     `HTTP-…`, `TST-…`. El cliente de mayoreo del caso real —`C1086`, MANUEL RIOS DURAN—
 *     **no existe** en nuestro padrón.
 *   · `commercial.warehouses` son **rutas** (`RUTA-21`, `01-003 Ruta 23 (PH)`), no sucursales.
 *     Y `commercial.erp_sucursal_warehouse`, que sería el puente, está **VACÍA**.
 *
 * O sea: el operador de telemarketing abría el alta y no encontraba a quién cotizar.
 *
 * ── Quién es un cliente de mayoreo: `C` + 4 dígitos ─────────────────────────────────────────
 * Confirmado por Dirección y medido: `kdud.c2 ~ '^C[0-9]{4}$'` da **207 clientes**, y la
 * auditoría E.9 había contado **206 clientes reales facturados por telemarketing**. Los otros
 * prefijos del padrón son otra cosa (`RUTA`, `RD`, `RV`, `OD`, `TI`, `CR`) y 1,307 no tienen
 * prefijo alfabético. Este discriminante es además el candidato directo para cerrar **E.10**
 * (re-apuntar la cola al universo correcto).
 *
 * ── Vista, no tabla (regla ⭐ del proyecto) ──────────────────────────────────────────────────
 * `analytics.v_erp_wholesale_customers` DERIVA de `kepler_ods.kdud`. Cero importers, cero
 * copias: la frescura es la del CDC y no hay nada que agendar ni que re-correr. Es exactamente
 * el caso `derive-no-copy`, y el antecedente de por qué importa es `analytics.customer_receivables`,
 * que quedó en prod como tabla vacía porque su importer nunca corrió.
 *
 * ⚠️ **Una fila por (cliente, sucursal), NO una por cliente.** Es deliberado y es el punto:
 * el mismo cliente tiene distinto límite de crédito, plazo y descuento según la sucursal que lo
 * atienda (medido: 204 de 1,574 clientes cambian de límite, 118 de plazo, 57 de descuento).
 * Colapsarlo a una fila por cliente obligaría a elegir una sucursal en silencio, que es
 * justamente la mentira que este módulo no puede contar.
 *
 * ── Cambios al esquema de `quotes` ──────────────────────────────────────────────────────────
 *   · `erp_customer_code` — la tercera vía de destinatario: un cliente que vive en Kepler y no
 *     en nuestro padrón. El CHECK de destinatario se amplía para aceptarla.
 *   · `warehouse_id` pasa a NULLABLE — para mayoreo el ancla es la SUCURSAL (`source_branch`),
 *     que es la que fija precio, condiciones y promociones. La ruta no aplica.
 *   · CHECK nuevo: si hay `erp_customer_code`, tiene que haber `source_branch`. Cotizarle a un
 *     cliente de Kepler sin decir desde qué sucursal es irreproducible (las condiciones difieren).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. La vista del padrón de mayoreo — derivada, sin copiar nada
  // ───────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_wholesale_customers
    WITH (security_invoker = true) AS
    SELECT
      trim(u.sucursal)                              AS sucursal,
      trim(u.c2)                                    AS customer_code,
      trim(u.c3)                                    AS name,
      nullif(trim(u.c4), '')                        AS address_1,
      nullif(trim(u.c5), '')                        AS address_2,
      nullif(trim(u.c6), '')                        AS state,
      nullif(trim(u.c27), '')                       AS postal_code,
      nullif(trim(u.c7), '')                        AS phone,
      nullif(trim(u.c10), '')                       AS rfc,
      nullif(trim(u.c12), '')                       AS salesperson_code,
      nullif(trim(u.c13), '')                       AS group_code,
      nullif(trim(u.c14), '')                       AS zone_code,
      -- Condiciones comerciales. NULL = el ERP no las trae; NUNCA 0 para decir "no sé".
      -- ⚠️ c15 y c16 ya vienen NUMERIC del ODS; c17/c18 vienen TEXT. Envolver un numeric en
      -- trim() revienta con "no existe la funcion btrim(numeric)": el tipo de una columna del
      -- ODS no se hereda de su vecina, se consulta.
      u.c15                                         AS credit_limit,
      u.c16::int                                    AS payment_days,
      nullif(trim(u.c17), '')::numeric              AS discount_1_pct,
      nullif(trim(u.c18), '')::numeric              AS discount_2_pct
    FROM kepler_ods.kdud u
    WHERE trim(u.c2) ~ '^C[0-9]{4}$'
  `);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_erp_wholesale_customers IS '[E.12.1] Padron de clientes de MAYOREO derivado de kepler_ods.kdud (c2 = C + 4 digitos; 207 clientes, coincide con los 206 que telemarketing factura segun la auditoria E.9). UNA FILA POR (cliente, sucursal) a proposito: limite de credito, plazo y descuento DIFIEREN entre sucursales. Vista derive-no-copy: cero importers.'`,
  );
  await knex.raw('GRANT SELECT ON analytics.v_erp_wholesale_customers TO app_runtime');

  // ───────────────────────────────────────────────────────────────────────────
  // 2. `quotes` aprende a cotizarle a un cliente que sólo vive en Kepler
  // ───────────────────────────────────────────────────────────────────────────
  const hasErpCode = await knex.schema
    .withSchema('commercial')
    .hasColumn('quotes', 'erp_customer_code');
  if (!hasErpCode) {
    await knex.schema.withSchema('commercial').alterTable('quotes', (t) => {
      t.string('erp_customer_code', 20);
      // Denormalizado a propósito: el nombre que se le cotizó, congelado. Si mañana el ERP le
      // cambia la razón social, la cotización tiene que seguir diciendo a quién se le ofreció.
      t.string('erp_customer_name', 200);
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.quotes.erp_customer_code IS '[E.12.1] Codigo del cliente de mayoreo en Kepler (C####). Tercera via de destinatario: el cliente vive en kdud y no en commercial.customers (solo 117 de 3,239 empatan).'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quotes.erp_customer_name IS 'Nombre congelado al cotizar. La cotizacion debe seguir diciendo a quien se le ofrecio aunque el ERP cambie la razon social.'`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_commercial_quotes_erp_customer
         ON commercial.quotes (tenant_id, erp_customer_code)`,
    );
  }

  // `warehouse_id` deja de ser obligatorio: para mayoreo el ancla es la sucursal.
  await knex.raw(`ALTER TABLE commercial.quotes ALTER COLUMN warehouse_id DROP NOT NULL`);
  await knex.raw(
    `COMMENT ON COLUMN commercial.quotes.warehouse_id IS 'Almacen/ruta propio. NULLABLE desde [E.12.1]: en mayoreo el ancla es source_branch (la sucursal Kepler), que es la que fija precio, condiciones y promociones; commercial.warehouses son RUTAS y no aplican.'`,
  );

  // El destinatario ahora tiene tres vías legítimas, y sigue sin poder no tener ninguna.
  await knex.raw(
    `ALTER TABLE commercial.quotes DROP CONSTRAINT IF EXISTS commercial_quotes_has_recipient`,
  );
  await knex.raw(`
    ALTER TABLE commercial.quotes
      ADD CONSTRAINT commercial_quotes_has_recipient
      CHECK (
        customer_id IS NOT NULL
        OR nullif(btrim(coalesce(erp_customer_code, '')), '') IS NOT NULL
        OR nullif(btrim(coalesce(contact_name, '')), '') IS NOT NULL
      )
  `);

  // Cotizarle a un cliente de Kepler sin decir desde qué sucursal es irreproducible: sus
  // condiciones difieren entre sucursales, así que el precio no se podría explicar después.
  await knex.raw(`
    ALTER TABLE commercial.quotes
      ADD CONSTRAINT commercial_quotes_erp_customer_needs_branch
      CHECK (erp_customer_code IS NULL OR source_branch IS NOT NULL)
  `);
};

exports.down = async function (knex) {
  await knex.raw(
    `ALTER TABLE commercial.quotes DROP CONSTRAINT IF EXISTS commercial_quotes_erp_customer_needs_branch`,
  );
  await knex.raw(
    `ALTER TABLE commercial.quotes DROP CONSTRAINT IF EXISTS commercial_quotes_has_recipient`,
  );
  await knex.raw(`
    ALTER TABLE commercial.quotes
      ADD CONSTRAINT commercial_quotes_has_recipient
      CHECK (customer_id IS NOT NULL OR nullif(btrim(coalesce(contact_name, '')), '') IS NOT NULL)
  `);
  await knex.schema.withSchema('commercial').alterTable('quotes', (t) => {
    t.dropColumn('erp_customer_code');
    t.dropColumn('erp_customer_name');
  });
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_wholesale_customers`);
};
