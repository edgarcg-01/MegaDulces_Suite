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

/**
 * El veredicto. `fresh` = medido y al día · `stale` = medido y viejo · `unknown` = **no se pudo
 * medir**, que no es lo mismo que estar al día y nunca se pinta como si lo fuera.
 */
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

/** Un eslabón de la cadena que produce un dato, con su edad y su veredicto. */
export interface FreshnessInput {
  key: string;
  label: string;
  /** ISO del último avance real, o `null` si la fuente no reporta. */
  at: string | null;
  age_human: string | null;
  status: FreshnessStatus;
  /** Derivado de `status`: `true` salvo que sea `fresh`. Ver el bloque VP.0.1 del encabezado. */
  stale: boolean;
}

export interface Freshness {
  /** El más viejo de los eslabones: hasta cuándo se puede afirmar que el dato es el vigente. */
  data_as_of: string | null;
  status: FreshnessStatus;
  /** Derivado de `status`: `true` salvo que sea `fresh`. Ver el bloque VP.0.1 del encabezado. */
  stale: boolean;
  age_human: string | null;
  /** Qué eslabón falla, para que el aviso nombre algo accionable y no sólo "hay rezago". */
  inputs: FreshnessInput[];
}

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
