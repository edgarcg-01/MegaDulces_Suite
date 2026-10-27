'use strict';
/**
 * `[OPS-AUD.12]` La llave que se MANDA a borrar al ODS.
 *
 * El timestamp de la PK va como TEXTO (la columna `_t_<col>` que la consulta trae con `::text`):
 * Postgres lo castea del literal y no hay huso de por medio. El Date de JS que devuelve el driver
 * para un `timestamp` viaja por JSON como UTC y vuelve corrido: medido el 2026-10-27 con el mismo
 * driver y la zona de la ingesta, pedir borrar `2026-09-20 00:00` borraba `2026-09-20 06:00` —
 * la OTRA copia de la misma póliza en `kdc2YYMM`.
 *
 * Un solo lugar para los dos caminos que borran en `reconcile-ods-window.js` (sobrantes y
 * duplicados). Antes sólo el de duplicados lo hacía bien.
 *
 * @param {Record<string, unknown>} r  fila leída del ODS (con `_t_<col>` para las columnas fecha)
 * @param {string[]} pk                columnas de la llave
 * @param {string} code                sucursal
 */
function pkParaEnviar(r, pk, code) {
  const o = { sucursal: code };
  for (const k of pk) o[k] = Object.prototype.hasOwnProperty.call(r, '_t_' + k) ? r['_t_' + k] : r[k];
  return o;
}

module.exports = { pkParaEnviar };
