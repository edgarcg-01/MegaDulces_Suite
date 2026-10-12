/**
 * `[AT.1]` — Pruebas del carril que corre la relectura solo.
 *
 * ⚠️ Un doble de Knex **no ejecuta SQL**: esto NO prueba que las consultas de `relectura()` sean
 * correctas (eso se mide corriéndolas contra prod). Lo que prueba es la **orquestación**, que es
 * donde está el riesgo propio de un cron: abrir el contexto de tenant, no solaparse consigo
 * mismo, y latir diciendo la verdad incluso cuando truena.
 *
 * La prueba que define el éxito es la primera: sin el contexto de tenant, `finance.
 * supplier_payment_proofs` (con RLS) devuelve CERO FILAS y la pasada reporta «cola vacía» para
 * siempre. Es la falla canónica de este repo (ADR-056) y ya le pasó al piloto de Presupuestos.
 */
import { describe, it, expect, vi } from 'vitest';
import { PagosAutopilotService } from './pagos-autopilot.service';
import { pasadaVacia, type ResultadoRelectura } from './relectura.engine';

/** Un knex falso que sólo registra lo que se le intentó escribir a `analytics.cron_runs`. */
function knexEspia() {
  const latidos: Record<string, unknown>[] = [];
  const tablas: string[] = [];
  const knex = ((tabla: string) => {
    tablas.push(tabla);
    const cadena = {
      insert(fila: Record<string, unknown>) { latidos.push(fila); return cadena; },
      onConflict() { return cadena; },
      merge() { return Promise.resolve([1]); },
    };
    return cadena;
  }) as never as { fn: { now: () => string } } & ((t: string) => unknown);
  (knex as unknown as { fn: { now: () => string } }).fn = { now: () => 'NOW()' };
  return { knex, latidos, tablas };
}

/** El `TenantContextService`, del que sólo se usa `run(scope, fn)`. */
function ctxEspia() {
  const scopes: unknown[] = [];
  return {
    scopes,
    ctx: { run: <T>(s: unknown, f: () => Promise<T>) => { scopes.push(s); return f(); } },
  };
}

const armar = (relectura: () => Promise<ResultadoRelectura>) => {
  const { knex, latidos } = knexEspia();
  const { ctx, scopes } = ctxEspia();
  const svc = { relectura: vi.fn(relectura) };
  const auto = new PagosAutopilotService(
    knex as never, svc as never, ctx as never,
  );
  return { auto, latidos, scopes, svc };
};

const pasada = (p: Partial<ResultadoRelectura>): ResultadoRelectura => ({ ...pasadaVacia(), ...p });

describe('[AT.1] el carril abre el contexto de tenant', () => {
  it('⛔⛔ sin esto la consulta con RLS devuelve CERO y el cron dice "cola vacía" para siempre', async () => {
    const { auto, scopes } = armar(async () => pasada({ revisados: 3, releidos: 3 }));
    await auto.run();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ tenantId: '00000000-0000-0000-0000-00000000d01c' });
  });

  it('la pasada corre DENTRO del contexto, no después', async () => {
    const orden: string[] = [];
    const { knex, latidos } = knexEspia();
    const ctx = { run: async <T>(_s: unknown, f: () => Promise<T>) => { orden.push('abre'); const r = await f(); orden.push('cierra'); return r; } };
    const svc = { relectura: async () => { orden.push('relee'); return pasada({ revisados: 1, releidos: 1 }); } };
    await new PagosAutopilotService(knex as never, svc as never, ctx as never).run();
    expect(orden).toEqual(['abre', 'relee', 'cierra']);
    expect(latidos).toHaveLength(1);
  });
});

describe('[AT.1] el latido dice la verdad (ADR-053)', () => {
  it('entrega sin fallas → ok, con la nota de lo entregado', async () => {
    const { auto, latidos } = armar(async () => pasada({ revisados: 25, releidos: 24, clasificados: 20, validados: 9, cambiaron: 2 }));
    await auto.run();
    expect(latidos[0]).toMatchObject({ job_key: 'pagos_relectura', status: 'ok', rows_affected: 24 });
    expect(String(latidos[0].note)).toContain('24/25 releidos');
    expect(String(latidos[0].note)).toContain('9 validados solos');
  });

  it('⛔ PRUEBA NEGATIVA: revisó y no releyó nada → error, aunque no haya excepción', async () => {
    const { auto, latidos } = armar(async () => pasada({ revisados: 25, releidos: 0, no_relegibles: { sin_hoja: 0, sin_archivo: 0, tipo_no_leible: 0, ilegible: 25 } }));
    await auto.run();
    expect(latidos[0].status).toBe('error');
  });

  it('⛔ la cola vacía NO es error', async () => {
    const { auto, latidos } = armar(async () => pasadaVacia());
    await auto.run();
    expect(latidos[0].status).toBe('ok');
    expect(latidos[0].rows_affected).toBe(0);
  });

  it('⛔ si la pasada TRUENA, igual late — y late en error con el motivo', async () => {
    const { auto, latidos } = armar(async () => { throw new Error('S3 unreachable'); });
    const r = await auto.run();
    expect(latidos).toHaveLength(1);
    expect(latidos[0].status).toBe('error');
    expect(String(latidos[0].error)).toContain('S3 unreachable');
    expect(r.errores).toHaveLength(1);
  });

  it('el host se LEE del entorno, no se afirma (en prod los cron viven en el worker)', async () => {
    const antes = process.env.WORKER;
    process.env.WORKER = 'true';
    try {
      const { auto, latidos } = armar(async () => pasadaVacia());
      await auto.run();
      expect(latidos[0].host).toBe('worker');
    } finally {
      if (antes === undefined) delete process.env.WORKER; else process.env.WORKER = antes;
    }
  });
});

describe('[AT.1] dos pasadas no se pisan', () => {
  it('⛔ si una sigue viva, la siguiente se salta: leerían el MISMO lote y se pagaría dos veces', async () => {
    let sueltalo: (() => void) | null = null;
    const bloqueada = new Promise<void>((r) => { sueltalo = r; });
    let corridas = 0;
    const { auto, latidos } = armar(async () => { corridas++; await bloqueada; return pasada({ revisados: 1, releidos: 1 }); });

    const primera = auto.run();
    await auto.scheduled();            // llega mientras la primera sigue adentro
    expect(corridas).toBe(1);
    expect(latidos).toHaveLength(0);   // la saltada no late: no pasó nada que contar

    sueltalo!();
    await primera;
    expect(corridas).toBe(1);
    expect(latidos).toHaveLength(1);
  });

  it('terminada una, la siguiente SÍ corre (el cerrojo se suelta aunque truene)', async () => {
    let corridas = 0;
    const { auto } = armar(async () => { corridas++; if (corridas === 1) throw new Error('boom'); return pasadaVacia(); });
    await auto.run();
    await auto.run();
    expect(corridas).toBe(2);
  });
});

describe('[AT.1] el interruptor de apagado', () => {
  it('ENABLE_PAGOS_AUTOPILOT=false apaga el disparo automático, no el manual', async () => {
    const antes = process.env.ENABLE_PAGOS_AUTOPILOT;
    process.env.ENABLE_PAGOS_AUTOPILOT = 'false';
    try {
      const { auto, svc } = armar(async () => pasadaVacia());
      await auto.scheduled();
      expect(svc.relectura).not.toHaveBeenCalled();
      await auto.run();                       // el botón sigue sirviendo
      expect(svc.relectura).toHaveBeenCalledTimes(1);
    } finally {
      if (antes === undefined) delete process.env.ENABLE_PAGOS_AUTOPILOT; else process.env.ENABLE_PAGOS_AUTOPILOT = antes;
    }
  });
});
