/**
 * [DH.1] LA RECURRENCIA — la regla con la que el tablero deja de olvidar.
 *
 * Vive en su propio archivo, **sin una sola importación**, por un motivo concreto: el candado
 * (`database/tests/test-newdb-db-health-recurrencia.js`) tiene que ejercitar ESTA función, no una
 * copia suya. Desde `db-health.service.ts` no se podía: ese archivo arrastra NestJS y el alias
 * `@megadulces/platform-core`, así que cargarlo desde un test de Node obligaba a reimplementar la
 * regla — y un test que reimplementa la regla se pone verde el día que alguien cambia la de
 * producción.
 *
 * ── Por qué existe la regla ─────────────────────────────────────────────────────────────────
 * `analytics.cron_runs` guarda **una fila por carril: la última corrida**. El tablero la pintaba y
 * nada más, o sea que sólo sabía responder *"¿cómo está en este instante?"*. Un carril que falla y
 * se recupera al ciclo siguiente se ve, justo cuando alguien mira, **idéntico a uno sano**.
 *
 * Medido contra prod el 2026-09-25, 7 días de `analytics.cron_run_log`:
 *
 *     cdc_reconcile ............................ 109 de 619 fallaron (17.6 %)
 *       y 103 de esas fallas dicen textual "el carril esta perdiendo filas"
 *     feed_nightly/import-cash-cuts.js .......... 6 de 6 (100 %)
 *     backup_prod ............................... 3 de 6 (50 %)
 *     stock_snapshot ............................ 2 de 3 (66.7 %)
 *
 * `cdc_reconcile` es **la única alarma de completitud del ODS** (`ops/README.md` §2.1). Estaba
 * gritando seis veces por día que se pierden filas, y en el momento de escribir esto la página lo
 * pintaba **verde**. La detección funcionaba; faltaba memoria.
 *
 * ── El umbral, y por qué 5 % ────────────────────────────────────────────────────────────────
 * No se eligió a ojo: se corrió contra los 45 carriles que fallaron alguna vez en 7 días y se miró
 * **a quién marca**. Con `>= 2 fallas Y >= 5 %` marca siete —los cuatro de arriba más
 * `cdc_reconcile_full` (11.8 %), `import-pos-ticket-sales` (8.2 %) y `products_active_refresh`
 * (20 %)— y deja callados a `auto_deploy` (4.6 %), `import-replenishment-plan` (4.3 %),
 * `store_poller` (3.7 %), `kepler_sales_fact` (3.3 %) y los 30 restantes. El piso de **2 fallas**
 * existe para que un carril diario con UN tropiezo (1 de 7 = 14 %) no encienda nada.
 *
 * ⚠️ Un umbral que marca a todos no informa: enseña a ignorar el tablero, que es la falla que
 * `ADR-053` existe para evitar. Por eso el corte se eligió mirando la lista de marcados, no al revés.
 */

export const RECURRENCIA = { dias: 7, minFallas: 2, pctFlojo: 5 } as const;

/** La semana de un carril: sus propias corridas, más los pasos suyos que fallaron. */
export interface SemanaCarril {
  runs: number;
  fails: number;
  /** Pasos `padre/paso.js` con fallas, ya formateados (`import-cash-cuts.js 6/6`). */
  pasos: string[];
}

/**
 * ¿La semana de este carril merece levantar la mano?
 *
 * Dos disparadores INDEPENDIENTES, y la diferencia importa:
 *   · el carril falla seguido **él mismo** (`>= minFallas` y `>= pctFlojo` %);
 *   · o alguno de **sus pasos** falla, aunque el carril salga `ok`.
 *
 * ⛔ El segundo no es un adorno: `run-prod-feeds.js` marca el carril en `error` **sólo si fallan
 * TODOS sus pasos** (está así a propósito, documentado en `[VL.4]`), y los pasos laten con llave
 * `padre/paso.js`, que **nunca llega a `cron_runs`**. Por eso
 * `feed_nightly/import-cash-cuts.js` pudo fallar siete noches seguidas con `feed_nightly` en `ok`.
 *
 * Pura y sin DB a propósito: para poder romperla en un test.
 */
export function recurrenciaLevantaLaMano(
  h: SemanaCarril,
  cfg: { minFallas: number; pctFlojo: number } = RECURRENCIA,
): { marca: boolean; propio: boolean; enPasos: boolean; pct: number } {
  const pct = h.runs ? (h.fails * 100) / h.runs : 0;
  const propio = h.fails >= cfg.minFallas && pct >= cfg.pctFlojo;
  const enPasos = h.pasos.length > 0;
  return { marca: propio || enPasos, propio, enPasos, pct };
}
