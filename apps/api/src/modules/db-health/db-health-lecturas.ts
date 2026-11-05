/**
 * `[DH.5]` Tres lecturas de `/admin/db-health` que publicaban algo falso. Viven aparte y SIN
 * dependencias por la misma razón que `db-health-recurrencia.ts`: que su candado las ejercite
 * de verdad, sin reimplementarlas.
 */

/**
 * **De qué base habla el tablero.** Antes era `/railway/i.test(...)` sobre la cadena de
 * conexión entera, y la base de producción en `md` se LLAMA `railway` (herencia de la
 * mudanza): el encabezado decía «prod (Railway)» en producción, o sea que nombraba a la prod
 * vieja y congelada. Se mira el HOST, nunca el nombre de la base.
 */
export function etiquetaBase(conexion: string | undefined | null): string {
  const raw = String(conexion ?? '').trim();
  if (!raw) return 'desconocida';
  let host = raw;
  try { host = new URL(raw).hostname; } catch { /* vino un host suelto, no una URL */ }
  if (/rlwy\.net$|railway\.app$|\.railway\.internal$/i.test(host)) return 'Railway (prod vieja, congelada)';
  if (/^pg-prod(\.|$)/i.test(host) || host === '192.168.0.222') return 'producción (md)';
  if (/^(localhost|127\.0\.0\.1|::1|postgres)$/i.test(host)) return 'local';
  return host;
}

/**
 * **Cuántas filas tiene la tabla, para el % de muertas.** `n_live_tup` es un contador de
 * actividad: Postgres lo pierde cuando la base se reinicia sin apagado limpio y lo vuelve a
 * sumar desde cero. Medido el 2026-11-04: `kepler_ods.kdm1` decía 12,164 vivas con
 * `reltuples` = 751,673, y el tablero pintaba 58.6 % de muertas («Crítico») cuando era 0.9 %.
 * `reltuples` es la estimación del planificador (la refrescan VACUUM y ANALYZE) y no se
 * reinicia; vale -1 si la tabla nunca se analizó, y entonces se cae al contador.
 */
export function filasEstimadas(nLiveTup: number, reltuples: number): number {
  const live = Number.isFinite(nLiveTup) && nLiveTup > 0 ? nLiveTup : 0;
  const est = Number.isFinite(reltuples) && reltuples > 0 ? Math.round(reltuples) : 0;
  return Math.max(live, est);
}

/** % de filas muertas sobre las vivas estimadas, a un decimal. `null` = no hay con qué dividir. */
export function pctMuertas(dead: number, filas: number): number | null {
  if (!(filas > 0)) return null;
  return Math.round((1000 * (Number(dead) || 0)) / filas) / 10;
}

/**
 * `[TOR.4]` **¿Es un carril retirado?** Nadie lo declara en `CRON_JOBS` y su latido no se escribe
 * hace más de una semana. Un carril se retira sacándolo de la lista (`[NORM.3]`), pero si su última
 * corrida fue un error su fila quedaba CRÍTICA para siempre: medido el 2026-11-04,
 * `route_collections` (retirado el 19-oct) y `mv_caja_push` (27-oct) seguían con alerta abierta.
 */
export function esCarrilRetirado(declarado: boolean, edadSeg: number | null): boolean {
  return !declarado && edadSeg != null && edadSeg > 7 * 86400;
}
