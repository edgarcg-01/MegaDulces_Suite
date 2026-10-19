import { describe, expect, it } from 'vitest';
import { UsageMetricsInterceptor } from './usage-metrics.interceptor';

/**
 * `[OPS.LIMPIEZA.1]` — Una ventana sin tráfico es un cero SANO, no un error.
 *
 * Medido en prod: `ui_usage_flush` salía `error` en el 38.8 % de sus latidos porque el motivo
 * «sin trafico en la ventana» viajaba como FALLA. Se ejerce el `latirCron` real contra un knex
 * de mentira que sólo captura la fila: lo que se prueba es el estado que llega a `cron_runs`.
 */
function knexQueCaptura() {
  const filas: Record<string, unknown>[] = [];
  const knex: any = (tabla: string) => ({
    insert: (fila: Record<string, unknown>) => {
      filas.push({ tabla, ...fila });
      return { onConflict: () => ({ merge: async () => [] }) };
    },
  });
  knex.fn = { now: () => 'now()' };
  knex.raw = (s: string) => s;
  return { knex, filas };
}

describe('UsageMetricsInterceptor — latido sin tráfico', () => {
  it('sin tráfico late OK con el motivo como nota, no como error', async () => {
    process.env['USAGE_METRICS'] = 'off'; // sin timer: la descarga se dispara a mano
    const { knex, filas } = knexQueCaptura();
    const i = new UsageMetricsInterceptor(knex);

    await i.onModuleDestroy(); // hace una última descarga con el buffer vacío

    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      tabla: 'analytics.cron_runs',
      job_key: 'ui_usage_flush',
      status: 'ok',
      rows_affected: 0,
    });
    expect(String(filas[0]['note'])).toContain('sin trafico');
  });
});
