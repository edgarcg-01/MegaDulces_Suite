/**
 * [OBS.6] Frescura declarada — el vocabulario común para que una respuesta diga **qué tan viejo es
 * el dato con el que se calculó**, en vez de presentarlo como si fuera de hace un segundo.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * El 2026-09-02 el carril de catálogos del ODS llevaba 6 días parado. La plataforma siguió
 * publicando precio, costo, margen y reorden con total confianza; lo descubrió un humano por
 * casualidad. La lección no fue "faltaba una alarma" (existía) sino que **el dato mismo no tenía
 * cómo declarar su edad donde se consume**.
 *
 * ── LAS DOS REGLAS QUE NO SE NEGOCIAN ────────────────────────────────────────────────────
 *  1. **Sin señal NO es "ok".** Es la falla más grave: la fuente ni siquiera reporta. El default
 *     permisivo (`?? 'ok'`) es exactamente cómo un feed muerto se disfraza de sano — es el bug que
 *     tenía `checkCronRuns` para los jobs sin registrar, y es el modo de falla de esta fase entera.
 *  2. **No poder MEDIR la frescura nunca se reporta como "fresco".** Se declara desconocida. Que
 *     falle el medidor no autoriza a afirmar lo que no se midió.
 *
 * ── [VP.0.1] POR QUÉ EL VEREDICTO ES TERNARIO ────────────────────────────────────────────
 * La primera versión de este archivo escribió las dos reglas de arriba y las incumplió: el
 * veredicto era `stale: boolean`, que **no puede expresar "no sé"**, y `FRESHNESS_UNKNOWN` salía
 * con `stale: false`. Los consumidores preguntan `@if (f.stale)`, así que **cuando fallaba la
 * medición la pantalla no mostraba nada** — afirmaba frescura por silencio, que es exactamente la
 * mentira que la regla 2 prohíbe, en la misma etiquetera que originó la fase.
 *
 * Por eso el campo autoritativo es `status: 'fresh' | 'stale' | 'unknown'`. `stale` sigue
 * existiendo —lo leen las vistas— pero pasa a ser **derivado**: `status !== 'fresh'`, o sea *"no
 * puedo afirmar que este dato está al día"*. Así un consumidor viejo que sólo mira `stale` empieza
 * a avisar también en `unknown`, sin tocarlo. El que quiera distinguir *viejo* de *no medido* lee
 * `status`.
 *
 * ── QUÉ NO VIVE ACÁ ──────────────────────────────────────────────────────────────────────
 * Los umbrales de OPERACIÓN. Esos son de `CRON_JOBS`/`EXT_SOURCES` en `db-health.service.ts` y
 * responden *"¿hay que despertar a alguien?"*. Lo de acá responde *"¿puedo confiar en este número
 * para tomar esta decisión?"* — misma medición, audiencias y tolerancias distintas. Cada consumidor
 * declara la suya y explica por qué.
 */

// [VP.2.1] La FORMA del wire vive en `@megadulces/contracts` (`http/provenance.contract.ts`), no
// acá: el frontend la necesita igual, y a los tres días de nacer este archivo el tipo ya estaba
// copiado a mano en `apps/view/.../tienda/etiquetas.service.ts`. Acá queda la LÓGICA — medir,
// componer, las tolerancias. Se re-exporta para no romper a quien ya importaba desde este módulo.
export type { Freshness, FreshnessInput, FreshnessStatus } from '@megadulces/contracts';
import type { Freshness, FreshnessInput, FreshnessStatus } from '@megadulces/contracts';

/** Edad en palabras. Corta en días arriba de 48 h: "73 h" no le dice nada a nadie. */
export function ageHuman(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'segundos';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} días`;
}

/**
 * Evalúa un eslabón contra SU tolerancia. `at` nulo → `unknown` (regla 1: sin señal no es ok), que
 * deriva en `stale: true` igual que antes — la fuente no reporta, así que no hay edad que afirmar.
 */
export function evalInput(key: string, label: string, at: unknown, maxHours: number): FreshnessInput {
  const d = at ? new Date(at as string | Date) : null;
  const valid = d && !Number.isNaN(d.getTime());
  const ms = valid ? Date.now() - (d as Date).getTime() : null;
  const status: FreshnessStatus =
    ms === null ? 'unknown' : ms > maxHours * 3_600_000 ? 'stale' : 'fresh';
  return {
    key,
    label,
    at: valid ? (d as Date).toISOString() : null,
    age_human: ms === null ? null : ageHuman(ms),
    status,
    stale: status !== 'fresh',
  };
}

/**
 * Compone el veredicto. `data_as_of` es el eslabón **más viejo** a propósito: una cadena es tan
 * fresca como su peor tramo, y promediar o quedarse con el mejor es cómo se dibuja un verde falso.
 */
export function composeFreshness(inputs: FreshnessInput[]): Freshness {
  const t = inputs.map((i) => i.at).filter(Boolean).map((a) => new Date(a as string).getTime());
  const viejo = t.length ? new Date(Math.min(...t)) : null;
  // Un eslabón medido y viejo gana el titular sobre uno no medido: tiene una edad concreta que
  // mostrar. `unknown` queda de titular cuando NADA está medidamente viejo pero algo no se pudo
  // medir. Sin eslabones no hay medición → `unknown`, nunca el `some([]) === false` que devolvía
  // "fresco" por lista vacía.
  const status: FreshnessStatus = inputs.some((i) => i.status === 'stale')
    ? 'stale'
    : inputs.length === 0 || inputs.some((i) => i.status === 'unknown')
      ? 'unknown'
      : 'fresh';
  return {
    data_as_of: viejo ? viejo.toISOString() : null,
    status,
    stale: status !== 'fresh',
    age_human: viejo ? ageHuman(Date.now() - viejo.getTime()) : null,
    inputs,
  };
}

/**
 * Frescura desconocida — lo que se devuelve cuando la medición falla. `stale: true` a propósito:
 * quien pregunte sólo por `stale` tiene que avisar igual. Ver el bloque VP.0.1 del encabezado.
 */
export const FRESHNESS_UNKNOWN: Freshness = {
  data_as_of: null,
  status: 'unknown',
  stale: true,
  age_human: null,
  inputs: [],
};

/**
 * Edad de un carril de ingesta según `analytics.v_feed_freshness`, con respaldo a
 * `analytics.cron_runs` si la vista todavía no está aplicada (el consumidor no puede romperse
 * entre el deploy y la migración).
 *
 * Devuelve `null` cuando el carril no reporta — y quien llame debe tratarlo como rezago, no como ok.
 */
/**
 * [VP.2.2] Edad de un dato medida **en la tabla que lo guarda**, no en el latido de quien la llena.
 *
 * ── POR QUÉ EXISTE, SI YA HAY `laneAt` ───────────────────────────────────────────────────
 * `laneAt` lee `analytics.cron_runs`: responde *"¿corrió el proceso?"*. Esto responde *"¿se movió
 * el dato?"* — y son distintas justo cuando importa. Un importer puede latir `ok` y no haber
 * escrito una fila (pasó: el carril de hash del ODS reportaba éxito mientras perdía filas, porque
 * `rowCount` no confirma el ship). La tesis de esta fase es **latido de ENTREGA**, y ésta es su
 * versión para el consumidor.
 *
 * ── Y POR QUÉ NO ERA OPCIONAL ACÁ ────────────────────────────────────────────────────────
 * Los reportes de venta por ruta, salidas y traspasos leen TABLAS (`sales_by_route_monthly`,
 * `sales_boxes_monthly`, `transfers_monthly`), no las matvistas del sell-out. Se verificó que
 * **ninguno** de sus tres importers llama a `cron-heartbeat` (VP.3.4 sigue abierto), así que no hay
 * carril que leer: con `laneAt` estas pantallas sólo podrían declarar "no medido" para siempre.
 * `max(updated_at)` sí es medible hoy, y de hecho es la mejor señal de las dos.
 *
 * ⚠️ Es `max(...)` sobre la tabla, **nunca** el `updated_at` de la fila que se está mostrando: el de
 * la fila se mueve sólo si ESE renglón cambió, y un producto que no se vendió en meses reportaría
 * una edad falsa de meses. Es el mismo error que ya se corrigió en la etiquetera.
 *
 * `tabla` y `col` son constantes del código —nunca entrada del usuario— y de todos modos se validan
 * como identificadores: interpolar un nombre de tabla es la única forma de escribir esta consulta,
 * y una validación que se da por obvia es la que no está.
 *
 * Devuelve `null` cuando la tabla no existe todavía (deploy antes de la migración) o está vacía — y
 * quien llame debe tratarlo como NO MEDIDO, no como ok.
 */
const TABLE_AT_TTL_MS = 60_000;
const tableAtCache = new Map<string, { at: string | null; hasta: number }>();

export async function tableAt(trx: any, tabla: string, col = 'updated_at'): Promise<string | null> {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(tabla) || !/^[a-z_][a-z0-9_]*$/.test(col)) {
    throw new Error(`tableAt: identificador inválido (${tabla}.${col})`);
  }
  // La medición NO tiene que ser por request. Medido en prod: `max(updated_at)` sin índice cuesta
  // **9.2 s** en `analytics.sales_boxes_monthly` (683 MB) y **7.2 s** en
  // `wincaja.maestro_mov_almacen` (449 MB) — seq scan completo. Cobrarle eso a cada reporte sería
  // cambiar un número honesto por una pantalla inusable, y la primera versión de esta función lo
  // hacía. Con tolerancias de 26 h, leer una frescura de hasta un minuto atrás no cambia ningún
  // veredicto. (El índice sigue haciendo falta para que la PRIMERA lectura no pague el scan: ver
  // la migración `..._freshness_max_idx`.)
  const clave = `${tabla}.${col}`;
  const hit = tableAtCache.get(clave);
  if (hit && hit.hasta > Date.now()) return hit.at;

  const existe = (await trx.raw(
    `SELECT to_regclass(?) IS NOT NULL AS ok`, [tabla],
  ))?.rows?.[0]?.ok;

  // ── LA MEDICIÓN NO PUEDE EMPEORAR LO QUE MIDE ──────────────────────────────────────────
  // Dos peligros, y el segundo es el grave:
  //   1. costo — mientras el índice de `..._freshness_max_idx` no esté aplicado, este `max()` es un
  //      seq scan de 9 s. Con tope de 2 s el reporte pierde la frescura (→ NO MEDIDO, que es la
  //      respuesta honesta) en vez de tardar 9 s;
  //   2. **contagio** — `trx` es la transacción DEL REPORTE. Un `statement_timeout` que expira
  //      aborta la transacción entera, así que una consulta accesoria de procedencia podría tumbar
  //      el reporte que venía a describir. El SAVEPOINT lo contiene: se revierte el error y el
  //      reporte sigue.
  // Y `SET LOCAL` es transaccional: `ROLLBACK TO SAVEPOINT` lo revierte solo, pero `RELEASE` NO —
  // por eso en el camino feliz se restaura a mano, o el tope de 2 s se quedaría aplicado al resto
  // de las consultas del reporte.
  let at: string | null = null;
  if (existe) {
    // ⚠️ Se restaura el valor QUE HABÍA, no `DEFAULT`. `DEFAULT` vuelve al valor de sesión y
    // **pisaría un `SET LOCAL` que el llamador ya puso**: `route-promo.service.ts` abre su
    // transacción con `statement_timeout = '60s'` justo para que una promo de marca × 3 canales
    // falle claro en vez de colgar la pantalla, y `commercial-analytics` usa 45 s. Restaurar a
    // `DEFAULT` les borraba ese tope en silencio — una medición de procedencia desarmando un guard
    // de otro, que es exactamente la clase de daño invisible que esta fase persigue.
    const previo = (await trx.raw('SHOW statement_timeout'))?.rows?.[0]?.statement_timeout ?? '0';
    await trx.raw('SAVEPOINT vp_freshness');
    try {
      await trx.raw(`SET LOCAL statement_timeout = '2s'`);
      at = (await trx.raw(`SELECT max(${col}) AS dato_al FROM ${tabla}`))?.rows?.[0]?.dato_al ?? null;
      await trx.raw(`SET LOCAL statement_timeout = ?`, [previo]);
      await trx.raw('RELEASE SAVEPOINT vp_freshness');
    } catch {
      // El rollback revierte el `SET LOCAL` de los 2 s por sí solo (es transaccional), así que acá
      // no hay que reponer nada: vuelve al valor que tenía el llamador.
      await trx.raw('ROLLBACK TO SAVEPOINT vp_freshness').catch(() => undefined);
      at = null; // no se pudo medir — nunca se reporta como fresco (regla 2)
    }
  }
  // Se cachea también el `null`: si la tabla no existe o está vacía, repetir la pregunta cada
  // request tampoco la va a llenar.
  tableAtCache.set(clave, { at: at ?? null, hasta: Date.now() + TABLE_AT_TTL_MS });
  return at ?? null;
}

export async function laneAt(trx: any, jobKey: string): Promise<string | null> {
  const hasView = (await trx.raw(
    `SELECT to_regclass('analytics.v_feed_freshness') IS NOT NULL AS ok`,
  ))?.rows?.[0]?.ok;
  const r = hasView
    ? await trx.raw(
        `SELECT dato_al FROM analytics.v_feed_freshness WHERE origen='cron' AND feed=?`, [jobKey])
    : await trx.raw(
        `SELECT COALESCE(last_finish, last_start) AS dato_al FROM analytics.cron_runs WHERE job_key=?`, [jobKey]);
  return r?.rows?.[0]?.dato_al ?? null;
}
