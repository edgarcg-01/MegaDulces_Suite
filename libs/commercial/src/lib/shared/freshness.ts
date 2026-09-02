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
 * ── QUÉ NO VIVE ACÁ ──────────────────────────────────────────────────────────────────────
 * Los umbrales de OPERACIÓN. Esos son de `CRON_JOBS`/`EXT_SOURCES` en `db-health.service.ts` y
 * responden *"¿hay que despertar a alguien?"*. Lo de acá responde *"¿puedo confiar en este número
 * para tomar esta decisión?"* — misma medición, audiencias y tolerancias distintas. Cada consumidor
 * declara la suya y explica por qué.
 */

/** Un eslabón de la cadena que produce un dato, con su edad y su veredicto. */
export interface FreshnessInput {
  key: string;
  label: string;
  /** ISO del último avance real, o `null` si la fuente no reporta. */
  at: string | null;
  age_human: string | null;
  stale: boolean;
}

export interface Freshness {
  /** El más viejo de los eslabones: hasta cuándo se puede afirmar que el dato es el vigente. */
  data_as_of: string | null;
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
 * Evalúa un eslabón contra SU tolerancia. `at` nulo → `stale: true` (regla 1: sin señal no es ok).
 */
export function evalInput(key: string, label: string, at: unknown, maxHours: number): FreshnessInput {
  const d = at ? new Date(at as string | Date) : null;
  const valid = d && !Number.isNaN(d.getTime());
  const ms = valid ? Date.now() - (d as Date).getTime() : null;
  return {
    key,
    label,
    at: valid ? (d as Date).toISOString() : null,
    age_human: ms === null ? null : ageHuman(ms),
    stale: ms === null ? true : ms > maxHours * 3_600_000,
  };
}

/**
 * Compone el veredicto. `data_as_of` es el eslabón **más viejo** a propósito: una cadena es tan
 * fresca como su peor tramo, y promediar o quedarse con el mejor es cómo se dibuja un verde falso.
 */
export function composeFreshness(inputs: FreshnessInput[]): Freshness {
  const t = inputs.map((i) => i.at).filter(Boolean).map((a) => new Date(a as string).getTime());
  const viejo = t.length ? new Date(Math.min(...t)) : null;
  return {
    data_as_of: viejo ? viejo.toISOString() : null,
    stale: inputs.some((i) => i.stale),
    age_human: viejo ? ageHuman(Date.now() - viejo.getTime()) : null,
    inputs,
  };
}

/** Frescura desconocida — lo que se devuelve cuando la medición falla. Nunca `stale: false` alegre. */
export const FRESHNESS_UNKNOWN: Freshness = {
  data_as_of: null,
  stale: false,
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
