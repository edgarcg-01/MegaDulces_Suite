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

/**
 * Columna de fecha de NEGOCIO por tabla. Una tabla que no esté acá NO tiene red de seguridad por
 * ventana: o entra en el modo `--chicas` del reconciliador (si es chica), o se queda sin red.
 *
 * `[ODS.2]` 2026-09-23 — se suma UNA (`kdfe33m1`). Se evaluaron cinco y CUATRO quedaron afuera con
 * motivo medido, que es el hallazgo importante de esta ronda:
 *
 * ⛔ HAY UN CORRIMIENTO DE 6 HORAS EN LOS TIMESTAMPS DEL ODS, anterior al 2026-09-23.
 *    Medido comparando la MISMA fila en la rama 08:
 *
 *        ODS      2026-09-21 06:00:00 | 06:41:34.99 | 17023 | BTO
 *        RÉPLICA  2026-09-21 00:00:00 | 06:41:34.99 | 17023 | BTO
 *
 *    Seis horas es exactamente `America/Mexico_City` (UTC−6): un `timestamp without time zone`
 *    tratado como si tuviera zona. El corte es limpio — TODO lo anterior al 09-23 está corrido y
 *    desde el 09-23 está bien, lo que apunta a la mudanza de prod (Railway `Etc/UTC` → `md`
 *    `America/Mexico_City`). Afecta a `kdpv_bitacora_precios`, `kdmx_26` y `kdlogmov`; NO afecta a
 *    `kdm1.c68`, así que no es global.
 *
 * ⚠️ POR ESO ESAS CUATRO NO ENTRAN. Con la llave corrida, los dos lados no discrepan en el DATO
 *    sino en la LLAVE: la misma fila cuenta como ausente Y como sobrante a la vez. Medido en seco,
 *    `kdpv_bitacora_precios` daba `faltan 38,487 · sobrantes 30,900` — y verificado en SQL puro con
 *    `::text` (30,900 / 38,365, las mismas cifras), así que no era artefacto del comparador de JS.
 *    Agregarlas convertiría la red de seguridad en un MOLINO: re-shipear 38k y borrar 30k en cada
 *    pasada, sin converger nunca. Entran cuando el corrimiento esté resuelto, no antes.
 *
 *    · `kdpv_bitacora_precios.c1`  timestamp corrido, Y en la PK
 *    · `kdlogmov.c2`               timestamp corrido, Y en la PK
 *    · `orglogtbl_26.k_date`       timestamp en la PK (`'…|INS|Sun Sep 20 2026 13:31:32…|347403'`)
 *    · `kdmx_26.c9`                la columna de ventana está corrida → cada lado elegiría filas distintas
 *
 * ⚠️ Y deja al descubierto un supuesto NO ESCRITO del reconciliador: `keyOf` hace `String(valor)`,
 *    así que la comparación de llaves sólo es válida si la PK es TEXTO. Las cinco tablas originales
 *    lo son por casualidad. Con una PK que traiga timestamp, `--delete-sobrantes` borraría filas
 *    VIVAS. Antes de sumar cualquier tabla acá, verificar el tipo de su PK.
 *
 * `kdfe33m1` sí entra: PK 100% texto (sucursal, c1, c2, c3) y `c6` con una sola columna de fecha.
 */
const RECENT_COL = {
  kdm1: 'c9', kdm2: 'c32', kdpord: 'c6', kdue: 'c7', kdij: 'c10',
  kdfe33m1: 'c6',
};

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
