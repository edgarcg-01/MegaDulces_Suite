/**
 * PV.0 (Fase PV, ADR-041) — Detalle de pólizas unificado para el motor de cuadre.
 *
 * Dos tablas nuevas que persisten la PARTIDA DOBLE COMPLETA por póliza (lo que
 * `analytics.ledger_monthly` pierde al sumar por cuenta/mes y `expense_entries`
 * pierde al guardar solo la pata de cargo). Sobre esto corren los detectores de
 * "¿se subió mal esta póliza?": no-cuadra, cuenta no-afectable, periodo, duplicado
 * exacto, importe ≠ CFDI (cruce por UUID), Kepler vs ContPAQi.
 *
 *   - analytics.gl_polizas       = header (una fila por póliza y fuente)
 *   - analytics.gl_poliza_lines  = asientos (N filas por póliza: las dos patas)
 *
 * `source`: 'contpaqi' (verdad fiscal, header ya trae Cargos/Abonos) | 'kepler'
 * (detalle por sucursal). Sin RLS (filtro de tenant explícito, igual que el resto
 * de analytics.*). Pobladas por los importers PV.1. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('gl_polizas'))) {
    await knex.raw(`
      CREATE TABLE analytics.gl_polizas (
        tenant_id            uuid NOT NULL,
        source               text NOT NULL,              -- 'contpaqi' | 'kepler'
        sucursal             text NOT NULL DEFAULT '00', -- '00' = CEDIS/consolidado (contpaqi)
        ejercicio            int  NOT NULL,              -- año fiscal
        periodo              int  NOT NULL,              -- 1..14 (13/14 = ajuste/cierre)
        tipo_pol             text NOT NULL,              -- ContPAQi 1/2/3 · Kepler doc_tipo (XA2001…)
        folio                text NOT NULL,
        anio_mes             text NOT NULL,              -- 'YYYY-MM' (periodo<=12) o 'YYYY-13/14'
        fecha                date,
        concepto             text,
        cargos               numeric NOT NULL DEFAULT 0, -- Σ patas cargo
        abonos               numeric NOT NULL DEFAULT 0, -- Σ patas abono
        neto                 numeric NOT NULL DEFAULT 0, -- cargos − abonos (0 = cuadra)
        num_lines            int NOT NULL DEFAULT 0,
        guid                 text,                       -- ContPAQi Polizas.Guid (UUID de la póliza)
        tiene_doc_bancario   boolean,
        computed_at          timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source, ejercicio, periodo, tipo_pol, folio, sucursal)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_glp_mes  ON analytics.gl_polizas (tenant_id, source, anio_mes)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_glp_neto ON analytics.gl_polizas (tenant_id, source, anio_mes) WHERE abs(neto) >= 0.01`);
    await knex.raw(`GRANT SELECT ON analytics.gl_polizas TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('gl_poliza_lines'))) {
    await knex.raw(`
      CREATE TABLE analytics.gl_poliza_lines (
        tenant_id            uuid NOT NULL,
        source               text NOT NULL,
        sucursal             text NOT NULL DEFAULT '00',
        ejercicio            int  NOT NULL,
        periodo              int  NOT NULL,
        tipo_pol             text NOT NULL,
        folio                text NOT NULL,
        num_movto            int  NOT NULL DEFAULT 0,     -- orden de la pata dentro de la póliza
        cuenta               text NOT NULL,
        cuenta_nombre        text,
        cuenta_afectable     boolean,                     -- false = cuenta padre (no debería postear)
        cuenta_mayor         text,
        familia              text,                        -- LEFT(cuenta,1)
        cargo_abono          text NOT NULL,               -- 'C' | 'A'
        importe              numeric NOT NULL DEFAULT 0,
        referencia           text,
        cfdi_uuid            text,                        -- de AsocCFDIs (null en kepler / patas sin CFDI)
        sat_agrupador        text,
        anio_mes             text NOT NULL,
        computed_at          timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source, ejercicio, periodo, tipo_pol, folio, sucursal, num_movto, cuenta, cargo_abono)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_gll_poliza ON analytics.gl_poliza_lines (tenant_id, source, ejercicio, periodo, tipo_pol, folio, sucursal)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_gll_cuenta ON analytics.gl_poliza_lines (tenant_id, source, cuenta, anio_mes)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_gll_cfdi   ON analytics.gl_poliza_lines (tenant_id, cfdi_uuid) WHERE cfdi_uuid IS NOT NULL`);
    await knex.raw(`GRANT SELECT ON analytics.gl_poliza_lines TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('gl_poliza_lines');
  await knex.schema.withSchema('analytics').dropTableIfExists('gl_polizas');
};
