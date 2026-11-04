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
 * **Qué commit dice el carril de despliegue que dejó corriendo.** `auto-deploy.sh` late en
 * `analytics.cron_runs` con «desplegado <sha> desde <sha> · …» o «al día en <sha>». La bitácora
 * `ops.deploys` sólo la escribe `deploy.sh` (el manual): desde k3s quedó parada en el 1-oct y el
 * tablero avisaba «alguien levantó un contenedor por fuera» en cada despliegue sano.
 * `null` = el latido no nombra un commit (un error, una espera): no hay contra qué comparar.
 */
export function commitDelLatido(nota: string | null | undefined): string | null {
  const m = /(?:desplegado|al día en|al dia en)\s+([0-9a-f]{7,40})\b/i.exec(String(nota ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** Dos sha del mismo commit pueden venir con distinto largo: coinciden si uno es prefijo del otro. */
export function mismoCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}
