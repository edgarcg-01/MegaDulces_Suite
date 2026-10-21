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

/**
 * `[ERR.1]` — Separar los RECHAZOS (4xx) de las FALLAS (5xx).
 *
 * Medido el 2026-10-21: el 29 % de «errores» de `/store/arqueo/rutas` eran 400 de validación,
 * contados igual que una caída. Sin separarlos, un issue por error real se ahoga en rechazos.
 */
import { BadRequestException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { claseDeError } from './usage-metrics.interceptor';

describe('claseDeError', () => {
  it('HttpException 4xx es rechazo', () => {
    expect(claseDeError(new BadRequestException('Elige la sucursal'))).toBe('4xx');
    expect(claseDeError(new ForbiddenException())).toBe('4xx');
  });
  it('HttpException 5xx es falla', () => {
    expect(claseDeError(new InternalServerErrorException())).toBe('5xx');
  });
  it('un error sin código es falla (Nest lo responde 500)', () => {
    expect(claseDeError(new Error('boom'))).toBe('5xx');
    expect(claseDeError(null)).toBe('5xx');
  });
  it('lee status/statusCode cuando no es HttpException', () => {
    expect(claseDeError({ status: 404 })).toBe('4xx');
    expect(claseDeError({ statusCode: 503 })).toBe('5xx');
  });
});

/** Un knex de mentira que guarda cada insert de `ui_usage` y puede fallar la primera vez. */
function knexDeUso(fallaPrimera?: { code: string }) {
  const inserts: Record<string, unknown>[][] = [];
  let pendiente = fallaPrimera;
  const knex: any = (tabla: string) => ({
    insert: (filas: Record<string, unknown>[] | Record<string, unknown>) => ({
      onConflict: () => ({
        merge: async () => {
          if (tabla === 'analytics.ui_usage') {
            if (pendiente) { const e = Object.assign(new Error('columna'), pendiente); pendiente = undefined; throw e; }
            inserts.push(Array.isArray(filas) ? filas : [filas]);
          }
          return [];
        },
      }),
    }),
  });
  knex.fn = { now: () => 'now()' };
  knex.raw = (s: string) => s;
  return { knex, inserts };
}

const peticion = { method: 'GET', route: { path: '/rutas' }, baseUrl: '/api/store/arqueo', user: { tenant_id: 't1', role_name: 'superadmin' } };

describe('UsageMetricsInterceptor — errores_4xx / errores_5xx', () => {
  it('descarga cuenta rechazos y fallas por separado; errores sigue siendo el total', async () => {
    process.env['USAGE_METRICS'] = 'off';
    const { knex, inserts } = knexDeUso();
    const i = new UsageMetricsInterceptor(knex) as any;
    i.anotar(peticion, 5, false);
    i.anotar(peticion, 5, true, '4xx');
    i.anotar(peticion, 5, true, '4xx');
    i.anotar(peticion, 5, true, '5xx');
    await i.onModuleDestroy();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toMatchObject({ hits: 4, errores: 3, errores_4xx: 2, errores_5xx: 1 });
  });

  it('⛔ prueba negativa: sin la migración (42703) reintenta SIN las columnas y no pierde la celda', async () => {
    process.env['USAGE_METRICS'] = 'off';
    const { knex, inserts } = knexDeUso({ code: '42703' });
    const i = new UsageMetricsInterceptor(knex) as any;
    i.anotar(peticion, 5, true, '5xx');
    await i.onModuleDestroy();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toMatchObject({ hits: 1, errores: 1 });
    expect(inserts[0][0]).not.toHaveProperty('errores_5xx');
    expect(i.estado().con_clases_de_error).toBe(false);
  });

  it('otro error de base NO se disfraza de 42703: la descarga reporta la falla', async () => {
    process.env['USAGE_METRICS'] = 'off';
    const { knex, inserts } = knexDeUso({ code: '57014' });
    const i = new UsageMetricsInterceptor(knex) as any;
    i.anotar(peticion, 5, true, '5xx');
    await i.onModuleDestroy();
    expect(inserts).toHaveLength(0);
    expect(i.estado().con_clases_de_error).toBe(true);
  });
});
