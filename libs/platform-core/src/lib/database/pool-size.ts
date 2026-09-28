/**
 * `[SEG.4.3]` EL TAMAÑO DEL POOL ES UN PARÁMETRO, PORQUE UNA API DE DEV NO ES UNA DE PROD.
 *
 * ── Qué lo obliga, medido el 2026-09-25 ─────────────────────────────────────────────────────
 * Con el entorno de desarrollo leyendo producción (`[REP.0.6]`), la API de un dev abre **cuatro
 * pools** contra el mismo servidor — legacy 10 + nueva 10 + runtime 10 + kepler 4 — o sea que
 * **una sola instancia puede pedir ~34 conexiones**. Con la cuenta limitada a 5 el login murió
 * con `53300 too many connections for role "edgar"`.
 *
 * La salida fácil —subirle el límite a la cuenta— no es gratis: `max_connections` de prod es
 * **200**, prod ya usa ~30, y cuatro devs a 40 serían 160. Dev podría dejar a **producción** sin
 * conexiones, que es exactamente lo que el límite por rol existe para impedir. El número no se
 * sube hasta donde haga falta: se baja lo que hace falta.
 *
 * ⭐ Un pool grande sirve cuando hay concurrencia real de usuarios. Una API de desarrollo atiende
 * a una persona. `DB_POOL_MAX=3` la deja en ~12 conexiones en total, y el límite por rol puede
 * seguir siendo chico — que es lo que protege a prod.
 *
 * ⚠️ El default NO cambia: sin la variable, cada pool queda exactamente como estaba. Este archivo
 * no puede alterar producción por accidente; sólo permite achicar a quien lo pida.
 */

/** Techo del pool: `DB_POOL_MAX` si es un entero ≥ 1, si no el valor de siempre. */
export function poolMax(pordefecto: number): number {
  const crudo = process.env['DB_POOL_MAX'];
  if (!crudo) return pordefecto;
  const n = Number.parseInt(crudo, 10);
  // ⚠️ Un valor basura (`""`, `abc`, `0`, negativo) NO baja el pool a algo inservible ni rompe el
  // arranque: se ignora y queda el default. Un pool de 0 es una API que no responde ninguna
  // consulta, y el síntoma no menciona la variable.
  return Number.isFinite(n) && n >= 1 ? n : pordefecto;
}

/** Piso del pool: nunca mayor que el techo, o knex no arranca. */
export function poolMin(pordefecto: number, max: number): number {
  return Math.min(pordefecto, max);
}
