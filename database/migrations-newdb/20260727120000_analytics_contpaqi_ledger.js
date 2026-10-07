/**
 * CP.1 — Balanza CONSOLIDADA de ContPAQi Contabilidad (Fase CP, ADR-040).
 *
 * `analytics.contpaqi_ledger_monthly` = balanza de comprobación de los LIBROS FISCALES
 * (SQL Server ContPAQi COMPAC, empresa `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ`), a nivel
 * cuenta × ejercicio × periodo. Verdad fiscal CONSOLIDADA de la entidad (persona física
 * Luis Francisco López Gutiérrez → tenant mega_dulces). NO por sucursal: la contabilidad
 * casi no usa segmento (~2% de movimientos con IdSegNeg) → el detalle por sucursal se
 * queda en Kepler (`analytics.ledger_monthly`); esta tabla es el espejo fiscal para
 * comparar (CP.4 "libros vs operación") y para que Maat lea los libros reales.
 *
 * Origen (decode 2026-07-27): SaldosCuentas (Tipo 2=cargos / 3=abonos, Importes1..14 por
 * periodo) ⋈ Cuentas (Codigo/Nombre/Afectable/IdAgrupadorSAT) ⋈ AgrupadoresSAT (código SAT
 * de contabilidad electrónica) ⋈ Ejercicios (Id→año). Cuadre confirmado: Σcargos≈Σabonos.
 *
 * La puebla `database/importers/contpaqi/import-contpaqi-ledger.js`. Aditiva, idempotente,
 * schema analytics, sin RLS (filtro de tenant explícito, igual que el resto de analytics.*).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('contpaqi_ledger_monthly'))) {
    await knex.raw(`
      CREATE TABLE analytics.contpaqi_ledger_monthly (
        tenant_id             uuid NOT NULL,
        cuenta                text NOT NULL,        -- Cuentas.Codigo (ej. '1020100000')
        cuenta_nombre         text,
        cuenta_afectable      boolean,              -- true = cuenta de detalle (donde se postea)
        familia               text,                 -- LEFT(Codigo,1): 1 activo … 5 gastos …
        agrupador_sat         text,                 -- AgrupadoresSAT.Codigo (contabilidad electrónica)
        agrupador_sat_nombre  text,
        ejercicio             int NOT NULL,          -- año fiscal (Ejercicios.Ejercicio)
        periodo               int NOT NULL,          -- 1..14 (13/14 = ajuste/cierre)
        anio_mes              text NOT NULL,         -- 'YYYY-MM' (periodo<=12) o 'YYYY-13/14'
        saldo_ini             numeric NOT NULL DEFAULT 0,  -- saldo inicial del EJERCICIO (repetido por periodo)
        cargos                numeric NOT NULL DEFAULT 0,
        abonos                numeric NOT NULL DEFAULT 0,
        neto                  numeric NOT NULL DEFAULT 0,   -- cargos − abonos
        computed_at           timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, cuenta, ejercicio, periodo)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_ledger_fam_mes ON analytics.contpaqi_ledger_monthly (tenant_id, familia, anio_mes)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_ledger_sat ON analytics.contpaqi_ledger_monthly (tenant_id, agrupador_sat, anio_mes)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_ledger_mes ON analytics.contpaqi_ledger_monthly (tenant_id, anio_mes)`);
    await knex.raw(`GRANT SELECT ON analytics.contpaqi_ledger_monthly TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('contpaqi_ledger_monthly');
};
