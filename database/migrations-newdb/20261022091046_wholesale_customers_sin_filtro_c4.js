'use strict';
/**
 * `[E.26]` — El padrón de la cotización deja de filtrar `C####`: es el padrón del ERP entero.
 *
 * ── La premisa que se refutó ────────────────────────────────────────────────────────────────
 * E.12.1 acotó `analytics.v_erp_wholesale_customers` a `kdud.c2 ~ '^C[0-9]{4}$'` con un dato
 * confirmado por Dirección: 207 clientes `C####` ≈ los 206 que telemarketing facturaba (E.9).
 * Medido el 2026-10-22 sobre lo que telemarketing PIDE (Kepler `U-D-40`, `c27 = 'TELEMARK'`, 30 d):
 *
 *   cliente                                     pedidos   importe    kdud.c17 = % del pedido
 *   C####  (la vista lo ve)                       1,151    $14.8 M    1,043 (90.6 %)
 *   CR#### / numéricos / CONTADO (la FILTRA)        439     $1.3 M      432 (98.4 %)
 *
 * O sea: **el 27.6 % de los pedidos de telemarketing son de clientes que la cotización no podía
 * encontrar** —el alta respondía «no existe en el padrón de mayoreo»— aunque `kdud` los tiene y
 * con el descuento correcto. El dato estaba bien; lo que fallaba era el filtro.
 *
 * ── Lo que cambia ───────────────────────────────────────────────────────────────────────────
 * Sólo el WHERE: mismas columnas, mismo orden, mismo grano (cliente × sucursal), mismo decode.
 * Se excluyen únicamente las fichas sin clave. La vista la usa sólo `commercial-quotes` (y sus
 * pruebas); no tiene dependientes en la base. Es lo que `FASE_DC` §9 llama `DC.0` para el flujo
 * de cotizaciones; los otros cuatro flujos siguen sin aplicar el descuento (decisión 1 de FASE_DC).
 *
 * Idempotente (CREATE OR REPLACE). El `down` restaura el filtro exacto de E.12.1.
 *
 * @param { import("knex").Knex } knex
 */

const COLUMNAS = `
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
      u.c15                                         AS credit_limit,
      u.c16::int                                    AS payment_days,
      nullif(trim(u.c17), '')::numeric              AS discount_1_pct,
      nullif(trim(u.c18), '')::numeric              AS discount_2_pct`;

async function vista(knex, where, comentario) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_wholesale_customers
    WITH (security_invoker = true) AS
    SELECT ${COLUMNAS}
    FROM kepler_ods.kdud u
    WHERE ${where}
  `);
  await knex.raw(`COMMENT ON VIEW analytics.v_erp_wholesale_customers IS '${comentario.replace(/'/g, "''")}'`);
  await knex.raw('GRANT SELECT ON analytics.v_erp_wholesale_customers TO app_runtime');
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const existe = await knex.raw(`SELECT to_regclass('kepler_ods.kdud') t`);
  if (!existe.rows[0].t) {
    console.log('  [e26] kepler_ods.kdud no existe en esta DB — se salta');
    return;
  }
  await vista(
    knex,
    `trim(u.c2) <> ''`,
    '[E.26] Padron de clientes del ERP para cotizar, derivado de kepler_ods.kdud SIN filtro de clave '
      + '(E.12.1 lo acotaba a C####; medido 2026-10-22: el 27.6 % de los pedidos de telemarketing son de '
      + 'clientes CR####, numericos o CONTADO). UNA FILA POR (cliente, sucursal): limite, plazo y descuento '
      + 'DIFIEREN entre sucursales. Vista derive-no-copy: cero importers.',
  );
  const r = await knex.raw(`SELECT count(*)::int n, count(*) FILTER (WHERE customer_code !~ '^C[0-9]{4}$')::int otros
                              FROM analytics.v_erp_wholesale_customers`);
  console.log(`  [e26] v_erp_wholesale_customers: ${r.rows[0].n} filas · ${r.rows[0].otros} con clave que no es C####`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve al filtro de E.12.1. */
exports.down = async function down(knex) {
  const existe = await knex.raw(`SELECT to_regclass('kepler_ods.kdud') t`);
  if (!existe.rows[0].t) return;
  await vista(
    knex,
    `trim(u.c2) ~ '^C[0-9]{4}$'`,
    '[E.12.1] Padron de clientes de MAYOREO derivado de kepler_ods.kdud (c2 = C + 4 digitos; 207 clientes, '
      + 'coincide con los 206 que telemarketing factura segun la auditoria E.9). UNA FILA POR (cliente, sucursal) '
      + 'a proposito: limite de credito, plazo y descuento DIFIEREN entre sucursales. Vista derive-no-copy: cero importers.',
  );
};
