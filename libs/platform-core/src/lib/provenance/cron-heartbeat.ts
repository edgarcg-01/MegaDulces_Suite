/**
 * [CC.10] **El latido de un cron, escrito UNA vez.**
 *
 * ── POR QUÉ SUBE ACÁ ─────────────────────────────────────────────────────────────────────
 * Medido el 2026-09-24: **siete servicios** escriben este mismo `INSERT … ON CONFLICT` a mano
 * (`analytics-refresh`, `period-close-check`, `stock-snapshot`, `customer-receivables-scanner`,
 * `goods-receipt-twins`, `fleet-poller`, `db-health-scanner`). El octavo iba a ser el de
 * cobranza, y ADR-056 es explícito: *un primitivo inventado en una fase no cierra la fase hasta
 * que vive en `libs/` compartido*. Vive acá, al lado de `laneAt()` —que es el que LEE lo que
 * esto escribe—, porque `platform-core` ya es dependencia de todos los dominios.
 *
 * ⛔ **Las tres reglas que la copia-pega se llevó mal más de una vez, y acá quedan fijas:**
 *
 *  1. **Cero entregado es `error`, no éxito silencioso.** Es el modo de falla real: la consulta
 *     corre perfecto contra una fuente vacía, el job «termina bien» y no entrega nada. Por eso
 *     `rowsAffected === 0` pinta rojo salvo que el llamador declare `ceroEsOk` **con motivo**.
 *  2. **El latido nunca rompe al que late** — pero **tampoco se calla**. El `catch` de las
 *     copias era mudo, y el 2026-09-23 el snapshot de cartera insertó sus filas mientras el
 *     tablero conservaba un `error` de dos días antes, sin un solo renglón que dijera por qué.
 *  3. **Sin su entrada en `CRON_JOBS`** (`apps/api/src/modules/db-health/db-health.service.ts`)
 *     esto no sirve de nada: el sensor cae en `cfg ? classify : 'ok'` y un cron parado se ve
 *     **verde**. Van juntos, siempre.
 *
 * ⚠️ Lo que mide es **ENTREGA** (ADR-053): `rowsAffected` es lo que CAMBIÓ, no cuántas filas se
 * revisaron. Un número que nunca se mueve no distingue sano de muerto.
 */
import { Logger } from '@nestjs/common';

const log = new Logger('cronHeartbeat');

export interface LatidoCron {
  /** El mismo `job_key` que su entrada en `CRON_JOBS`. Si no coinciden, el sensor no lo ve. */
  jobKey: string;
  label: string;
  tenantId: string;
  /** Lo que se ENTREGÓ (filas escritas/cambiadas), no lo que se recorrió. */
  rowsAffected: number;
  durationMs: number;
  /** Lo que salió mal. Con uno solo, la corrida es `error`. */
  fallas?: readonly string[];
  /** Resumen legible para el tablero. Se omite cuando hay error. */
  note?: string | null;
  /**
   * Motivo por el que entregar CERO es legítimo en este job (p. ej. «no hubo movimientos hoy»).
   * Sin motivo, cero es `error`. Que la excepción exija explicarse es el punto.
   */
  ceroEsOk?: string;
  /** Default `'api'`. Los carriles de ingesta ponen el suyo. */
  host?: string;
}

/**
 * Escribe (o pisa) el renglón de `analytics.cron_runs` del job. Nunca lanza.
 *
 * @returns `true` si quedó escrito. Un `false` significa que **el tablero conserva la marca
 *   anterior** — que es lo que el llamador necesita saber para no creerle.
 */
export async function latirCron(knex: any, l: LatidoCron): Promise<boolean> {
  const fallas = (l.fallas || []).filter(Boolean);
  const vacio = !fallas.length && (l.rowsAffected ?? 0) === 0 && !l.ceroEsOk;
  const error = fallas.length
    ? fallas.join(' | ').slice(0, 500)
    : vacio
      ? 'cero entregado: el job corrio y no escribio una sola fila (fuente vacia, sin acceso, o filtro que no matchea)'
      : null;
  try {
    await knex('analytics.cron_runs')
      .insert({
        tenant_id: l.tenantId,
        job_key: l.jobKey,
        label: l.label,
        last_start: knex.fn.now(),
        last_finish: knex.fn.now(),
        status: error ? 'error' : 'ok',
        rows_affected: l.rowsAffected ?? 0,
        duration_ms: l.durationMs,
        note: error ? null : (l.note ?? l.ceroEsOk ?? null),
        error,
        host: l.host || 'api',
        updated_at: knex.fn.now(),
      })
      .onConflict(['tenant_id', 'job_key'])
      .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected',
        'duration_ms', 'note', 'error', 'host', 'updated_at']);
    return true;
  } catch (e) {
    // Regla 2: no rompe, pero deja rastro. Un medidor que se calla cuando falla es el modo de
    // falla que la Fase OBS existe para cerrar, una capa más arriba.
    log.error(`latido "${l.jobKey}" NO escrito (el tablero conserva la marca anterior): `
      + `${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
