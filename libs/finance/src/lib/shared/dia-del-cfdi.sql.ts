/**
 * **El día (México) de un CFDI de `fiscal.cfdis`, según su fuente.** `fecha` tiene DOS convenciones:
 *
 * - `contpaqi_add` guarda la hora LOCAL del atributo `Fecha` del XML como si fuera UTC. Medido en prod el
 *   2026-11-26: **2,232 de 2,232** recibidas desde octubre coinciden con el XML leídas en UTC y **0** leídas en hora
 *   de México (S.13 lo midió antes: 2,005 de 2,005).
 * - `descarga_masiva` guarda el instante real: se lee en hora de México.
 *
 * Leer todas en hora de México corre un día las de ContPAQi timbradas de 00:00 a 05:59. En el freno de la PUE
 * (`[PGP.225]`) eso pasaba **21 PUE de 2026 al mes anterior** (timbradas el día 1 de madrugada) y las habría
 * detenido por error. Una sola lectura para todos (ADR-056): S.13 y el Calendario la usan.
 *
 * ⚠️ Deuda con nombre: `SQL_PAGADAS_CANCELADAS` (`[PGP.178]`, `cfdi-factura.sql.ts`) todavía lee el día en hora de
 * México para sus ventanas de 45 y 120 días; cambiarlo mueve su cifra y va con su medición.
 */
export function sqlDiaDelCfdi(alias = 'c'): string {
  return `to_char(CASE WHEN ${alias}.source = 'descarga_masiva' THEN ${alias}.fecha AT TIME ZONE 'America/Mexico_City'
                       ELSE ${alias}.fecha AT TIME ZONE 'UTC' END, 'YYYY-MM-DD')`;
}
