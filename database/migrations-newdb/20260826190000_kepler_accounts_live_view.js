/**
 * FKJ (copia → vista) — `finance.kepler_accounts` de tabla materializada por importer nightly a
 * VISTA derive-no-copy sobre `analytics.ledger_monthly`. Mismo patrón que
 * erp_customers/erp_promotions/erp_shipments (mig 20260820150000/160000/170000): la tabla se
 * RENOMBRA a `*_snapshot_bak` (no se borra) y la vista toma su nombre → contrato de 8 columnas
 * idéntico, cero cambios en el consumidor (`FinanceBankService.keplerAccounts`, CB.13).
 *
 * DERIVE: el SELECT de `import-kepler-accounts.js` — distinct de cuenta del almacén canónico '00'
 * (CEDIS) con su nombre + su mayor; `cuenta_mayor_nombre` sale de la cuenta cuyo código == su
 * propio mayor (lo que el importer armaba en JS con un diccionario).
 *
 * UN CAMBIO A PROPÓSITO — el nombre es el VIGENTE, no `MAX()`. El importer resolvía el empate con
 * `MAX(cuenta_nombre)`, que es orden alfabético y por lo tanto DEPENDE DEL COLLATION de la DB donde
 * corre: medido 2026-08-26, para `605-005` (renombrada en Kepler: 2025-04 'MANTENIMIENTO CAMARAS
 * SEGUTRID' → 2026-02 'MANT. NO BREAK') prod (`en_US.utf8`) devuelve 'MANT. NO BREAK' y la réplica
 * (`Spanish_Mexico.1252`) devuelve la otra — el mismo importer, dos resultados. Son 3 cuentas con
 * más de un nombre. La vista toma el nombre del MES MÁS RECIENTE que lo trae (`anio_mes COLLATE "C"
 * DESC`): determinista, independiente del collation y además es la respuesta correcta — el nombre
 * de hoy, no el alfabéticamente mayor. `cuenta_mayor` sigue con `MIN()` porque no hay ninguna
 * cuenta con más de un mayor (verificado: 0), así que ahí no hay empate que resolver.
 *
 * GATE DE COSTO (medido en prod 2026-08-26, ver database/scripts/bench-ods-derive-stock-movements.js
 * para el caso que NO pasa): fuente 2,548 filas / 1.3 MB · paridad 175 = 175 filas con 0 campos
 * distintos · la búsqueda real del lector cuesta lo mismo que contra la tabla (140 ms vs 140 ms).
 * Un derive solo se convierte en vista si pasa este gate — `analytics.stock_movements` lo falla
 * por 89–517× y se queda materializado.
 *
 * TENANT: ojo, este caso NO es como los `analytics.*`. `finance.kepler_accounts` tiene RLS
 * FORZADO con policy `tenant_id = current_tenant_id()` y su lector NO filtra tenant — confía en
 * la policy. Una vista no hereda RLS, así que el filtro va DENTRO de la vista con la misma
 * función: sin tenant en la sesión, `current_tenant_id()` es NULL → 0 filas, idéntico a la RLS
 * que reemplaza. `security_invoker = true` (PG 15+, prod corre 18.6) para que los privilegios se
 * evalúen como el que consulta y no como el dueño de la vista; `app_runtime` ya tiene SELECT
 * sobre `analytics.ledger_monthly`.
 *
 * Reversible (`down` devuelve la tabla). Idempotente (guard por relkind).
 * @param { import("knex").Knex } knex
 */

const VIEW = `
  CREATE VIEW finance.kepler_accounts
    WITH (security_invoker = true) AS
  WITH src AS (
    SELECT tenant_id, cuenta, cuenta_nombre, cuenta_mayor, anio_mes
      FROM analytics.ledger_monthly
     WHERE sucursal = '00' AND cuenta IS NOT NULL
       AND tenant_id = current_tenant_id()
  ),
  nombre AS (  -- el nombre VIGENTE: el del mes más reciente que lo trae (no MAX alfabético)
    SELECT DISTINCT ON (tenant_id, cuenta) tenant_id, cuenta, cuenta_nombre
      FROM src
     WHERE cuenta_nombre IS NOT NULL
     ORDER BY tenant_id, cuenta, anio_mes COLLATE "C" DESC
  ),
  base AS (
    SELECT s.tenant_id, s.cuenta, n.cuenta_nombre,
           MIN(s.cuenta_mayor) AS cuenta_mayor
      FROM src s
      LEFT JOIN nombre n ON n.tenant_id = s.tenant_id AND n.cuenta = s.cuenta
     GROUP BY s.tenant_id, s.cuenta, n.cuenta_nombre
  ),
  mayor AS (  -- nombre del mayor = nombre de la cuenta cuyo código ES el mayor
    SELECT tenant_id, cuenta_mayor, cuenta_nombre
      FROM base
     WHERE cuenta = cuenta_mayor AND cuenta_nombre IS NOT NULL
  )
  SELECT b.tenant_id,
         b.cuenta,
         b.cuenta_nombre,
         b.cuenta_mayor,
         m.cuenta_nombre        AS cuenta_mayor_nombre,
         (b.cuenta = b.cuenta_mayor) AS es_mayor,
         '00'::text             AS sucursal_ref,
         now()                  AS computed_at
    FROM base b
    LEFT JOIN mayor m ON m.tenant_id = b.tenant_id AND m.cuenta_mayor = b.cuenta_mayor
`;

exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('finance.kepler_accounts')`);
  const kind = rk.rows[0] && rk.rows[0].relkind;
  if (kind === 'v') return; // ya es vista
  // Sin la fuente no tiene sentido crear la vista (DB nueva / orden de migraciones).
  if (!(await knex.raw(`SELECT to_regclass('analytics.ledger_monthly') t`)).rows[0].t) return;
  if (kind === 'r') {
    await knex.raw('ALTER TABLE finance.kepler_accounts RENAME TO kepler_accounts_snapshot_bak');
  }
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON finance.kepler_accounts TO app_runtime');
  await knex.raw(`COMMENT ON VIEW finance.kepler_accounts IS
    'Vista derive-no-copy: catálogo de cuentas EN VIVO desde analytics.ledger_monthly (almacén canónico 00). Filtra tenant_id = current_tenant_id() porque una vista no hereda la RLS forzada que tenía la tabla. Reemplaza la copia nightly (import-kepler-accounts.js retirado). Backup: finance.kepler_accounts_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS finance.kepler_accounts');
  const bak = await knex.raw(`SELECT 1 FROM pg_class WHERE oid = to_regclass('finance.kepler_accounts_snapshot_bak')`);
  if (bak.rows.length) {
    await knex.raw('ALTER TABLE finance.kepler_accounts_snapshot_bak RENAME TO kepler_accounts');
  }
};
