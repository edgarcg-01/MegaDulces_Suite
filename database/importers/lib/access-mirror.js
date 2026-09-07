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
 *
 * `extraKeys` (opt-in, default vacío) prefija columnas de partición a esa identidad. Lo usa el carril
 * HISTÓRICO de Wincaja (`import-wincaja-hist.js`) con `['_dataset']`: cada carpeta `<año>` es el corte
 * de ESE año y **el `Consecutivo` reinicia en 1 cada año** (verificado 2026-09-01: suc 32 → 2021 va
 * 1..89,586 y 2025 va 1..129,760, tickets distintos con el mismo número). Sin el año en la identidad
 * los años se pisan entre sí en silencio. El carril vivo NO lo pasa → su comportamiento no cambia.
 */
const { jetToPg } = require('./access-adapter');

const HK_HASH = '_row_hash';
const HK_SYNC = '_synced_at';
/**
 * `[WR.8]` Número de repetición de una fila **byte-idéntica** dentro de la partición: 1 para la
 * primera, 2 para la segunda igual, etc.
 *
 * Por qué existe: con identidad `(_dataset, _row_hash)` dos filas idénticas colapsan en una y el
 * espejo deja de ser espejo. Medido el 2026-09-07 sobre el corpus histórico (14,635 cargas /
 * 146,289,530 filas): **19,321 filas perdidas** — DetallesMovAlmacen 18,433 · DetalleCotizaciones
 * 882 · MovimientoClientes 4 · OrdenesCompra 2. Son renglones de ticket y de cotización: dos
 * renglones idénticos son dos veces la cantidad, no un error de captura que corresponda deduplicar.
 * El espejo crudo no está para discutirle a la fuente.
 *
 * Es DETERMINISTA y por eso sirve como identidad: se calcula
 * `row_number() OVER (PARTITION BY <hash>)` — cuál de las filas idénticas recibe el 1 es arbitrario,
 * y da exactamente igual, porque son la misma fila byte a byte. Recargar la partición reproduce el
 * mismo conjunto.
 */
const HK_OCC = '_ocurrencia';

/** Cita un identificador Postgres preservando el case exacto de Access. */
function q(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

/**
 * DDL del espejo de una tabla. Devuelve null si la tabla no expuso columnas.
 * `extraKeys` = columnas `text NOT NULL` de partición que se prefijan a la identidad (ver cabecera).
 */
function mirrorDDL(schema, t, { extraKeys = [], withOccurrence = false } = {}) {
  const cols = (t.columns || []).filter((c) => c && c.name);
  if (!cols.length) return null;
  const lines = extraKeys.map((k) => `  ${q(k)} text NOT NULL`);
  // `c.pg` = tipo ya resuelto (lo trae `mdb-tools.describe`, que lee el tipo de mdb-schema);
  // `c.jet` = tipo Jet crudo (lo trae `access-adapter.discoverSchema`). Un solo generador para los dos.
  lines.push(...cols.map((c) => `  ${q(c.name)} ${c.pg || jetToPg(c.jet)}`));
  lines.push(`  ${HK_HASH} text`);
  const pk = (t.pk || []).filter(Boolean);
  // `_ocurrencia` sólo tiene sentido donde la identidad es el CONTENIDO de la fila: con PK natural
  // dos filas idénticas ya son distinguibles por su clave.
  const conOcc = withOccurrence && !pk.length;
  if (conOcc) lines.push(`  ${HK_OCC} integer NOT NULL DEFAULT 1`);
  lines.push(`  ${HK_SYNC} timestamptz NOT NULL DEFAULT now()`);
  if (pk.length) {
    lines.push(`  CONSTRAINT ${q(t.table + '_pk')} PRIMARY KEY (${[...extraKeys, ...pk].map(q).join(', ')})`);
  } else {
    const ident = [...extraKeys, HK_HASH, ...(conOcc ? [HK_OCC] : [])];
    lines.push(`  CONSTRAINT ${q(t.table + '_uq')} UNIQUE (${ident.map(q).join(', ')})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(t.table)} (\n${lines.join(',\n')}\n);`;
}

/** Columnas que forman el conflict target del UPSERT (PK natural o el surrogate _row_hash). */
function conflictTarget(t, { extraKeys = [], withOccurrence = false } = {}) {
  const pk = (t.pk || []).filter(Boolean);
  if (pk.length) return [...extraKeys, ...pk];
  return [...extraKeys, HK_HASH, ...(withOccurrence ? [HK_OCC] : [])];
}

/** Nombres de las columnas de datos (sin housekeeping) — el orden del INSERT. */
function dataColumns(t) {
  return (t.columns || []).filter((c) => c && c.name).map((c) => c.name);
}

module.exports = { mirrorDDL, conflictTarget, dataColumns, q, HK_HASH, HK_SYNC, HK_OCC };
