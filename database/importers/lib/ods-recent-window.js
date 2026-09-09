'use strict';
/**
 * Ventana "reciente" de las tablas del carril CTID del ODS. La comparten la red de seguridad de
 * `replicate-ods-live.js` (re-envía la ventana por UPSERT) y `reconcile-ods-window.js` (compara
 * llaves replica↔ODS). Antes cada script traía su propia copia de `RECENT_COL` y los dos tenían
 * el mismo punto ciego.
 *
 * EL PUNTO CIEGO (2026-09-09): la ventana de `kdm1` iba SÓLO por `c9` = fecha VALOR del documento,
 * y en tesorería se captura con fecha valor atrasada (un pago capturado el 07-sep con valor 02-sep;
 * nóminas del 08-sep con valor 02-ene). Cuando el ctid no monótono del subscriber saltaba una de esas
 * filas, la red de seguridad de 3 días NO la recuperaba (su `c9` ya estaba fuera) y el reconciliador
 * tampoco la veía (misma ventana en los dos lados) → la fila faltaba en el ODS para siempre.
 * Medido en prod: 17 pagos `X-D-26` de Oficinas capturados desde el 2026-08-25 ausentes del ODS,
 * los 17 con `c68 - c9 > 3 días`, ninguno con `<= 3`. Entre ellos el folio 0019791 ($3,550) que el
 * Cuadre de Caja no podía casar.
 *
 * Fix: la ventana de `kdm1` es `c9` O `c68` (fecha de CAPTURA, la que dice cuándo la fila se movió
 * de verdad; ver ERP_KEPLER `kdm1.c68`). El resto de tablas no trae fecha de captura conocida:
 * quedan con su fecha de negocio (`kdm2.c32` ≡ fecha del header, verificado 99.999%).
 *
 * Type-guard: sólo entran columnas que EXISTEN y son fecha/timestamp en el replica; si ninguna
 * califica devuelve null y la tabla se queda sin ventana (degradación limpia, sin spamear
 * "operator does not exist: X >= date").
 */

/** Columna de fecha de NEGOCIO por tabla (la que ya estaba en los dos scripts). */
const RECENT_COL = { kdm1: 'c9', kdm2: 'c32', kdpord: 'c6', kdue: 'c7', kdij: 'c10' };

/** Columnas ADICIONALES que amplían la ventana: fecha de CAPTURA, donde se conoce. */
const RECENT_EXTRA_COLS = { kdm1: ['c68'] };

const qid = (s) => `"${String(s).replace(/"/g, '""')}"`;
const isDateType = (t) => /date|timestamp/.test(String(t || ''));

/**
 * Columnas de fecha que definen la ventana de `table`, filtradas por existencia y tipo.
 * @param {string} table
 * @param {{column_name:string,data_type:string}[]} cols  columnas del replica (information_schema)
 * @returns {string[]}  [] si la tabla no tiene ventana
 */
function recentWindowCols(table, cols) {
  const base = RECENT_COL[table];
  if (!base) return [];
  const byName = new Map((cols || []).map((c) => [c.column_name, c.data_type]));
  return [base, ...(RECENT_EXTRA_COLS[table] || [])].filter((c) => isDateType(byName.get(c)));
}

/**
 * Predicado SQL de la ventana (`"c9" >= current_date - N OR "c68" >= current_date - N`), o null si
 * la tabla no tiene ninguna columna de fecha válida. `days` se castea a entero para no interpolar
 * texto ajeno en el SQL.
 */
function recentWindowSql(table, cols, days) {
  const n = Math.max(1, Math.trunc(Number(days) || 0));
  const parts = recentWindowCols(table, cols).map((c) => `${qid(c)} >= current_date - ${n}`);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

module.exports = { RECENT_COL, RECENT_EXTRA_COLS, recentWindowCols, recentWindowSql };
