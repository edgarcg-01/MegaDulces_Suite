'use strict';
/**
 * Adapter Access -> Postgres (Fases WR / CA) — GENERADOR DE DDL ESPEJO + identidad de escritura.
 * Genérico (Wincaja + CEDIS Kepler-Access). Toma un tableSchema de `access-adapter.discoverSchema`
 * y produce el `CREATE TABLE` del espejo CRUDO en Postgres.
 *
 * Filosofía (FASE_WR §5): el espejo es CRUDO y tolerante — tipos laxos (numeric/text, sin precisión),
 * valores corruptos se espejan tal cual, el saneamiento vive en silver. Cada tabla lleva 2 columnas de
 * housekeeping:
 *   _row_hash text     -> identidad de la fila para el carril hash-delta y conflict-target sin PK natural.
 *   _synced_at timestamptz -> frescura (cuándo la tocó el loop).
 *
 * Identidad de escritura (conflict target del UPSERT):
 *   - PK natural declarada  -> esa PK (updates in-place: catálogos, MaestroMovAlmacen, Cortes, Retiros).
 *   - sin PK                 -> UNIQUE(_row_hash) surrogate (movimientos append-only: DetallesMovAlmacen, PagosDia).
 */
const { jetToPg } = require('./access-adapter');

const HK_HASH = '_row_hash';
const HK_SYNC = '_synced_at';

/** Cita un identificador Postgres preservando el case exacto de Access. */
function q(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

/** DDL del espejo de una tabla. Devuelve null si la tabla no expuso columnas. */
function mirrorDDL(schema, t) {
  const cols = (t.columns || []).filter((c) => c && c.name);
  if (!cols.length) return null;
  const lines = cols.map((c) => `  ${q(c.name)} ${jetToPg(c.jet)}`);
  lines.push(`  ${HK_HASH} text`);
  lines.push(`  ${HK_SYNC} timestamptz NOT NULL DEFAULT now()`);
  const pk = (t.pk || []).filter(Boolean);
  if (pk.length) {
    lines.push(`  CONSTRAINT ${q(t.table + '_pk')} PRIMARY KEY (${pk.map(q).join(', ')})`);
  } else {
    lines.push(`  CONSTRAINT ${q(t.table + '_uq')} UNIQUE (${HK_HASH})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(t.table)} (\n${lines.join(',\n')}\n);`;
}

/** Columnas que forman el conflict target del UPSERT (PK natural o el surrogate _row_hash). */
function conflictTarget(t) {
  const pk = (t.pk || []).filter(Boolean);
  return pk.length ? pk : [HK_HASH];
}

/** Nombres de las columnas de datos (sin housekeeping) — el orden del INSERT. */
function dataColumns(t) {
  return (t.columns || []).filter((c) => c && c.name).map((c) => c.name);
}

module.exports = { mirrorDDL, conflictTarget, dataColumns, q, HK_HASH, HK_SYNC };
