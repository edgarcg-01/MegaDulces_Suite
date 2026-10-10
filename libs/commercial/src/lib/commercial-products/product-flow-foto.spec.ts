import { vi } from 'vitest';
import { ProductFlowService } from './product-flow.service';
import type { CuidarRespuesta } from './product-flow';

/**
 * `[PF.6]` «Para cuidar hoy» sale de la foto que el worker calcula cada minuto; sin foto (o vieja, o sin la
 * tabla todavía) se calcula en vivo y se dice. El worker escribe las DOS variantes y deja su latido.
 */
const RESP = (costo: boolean): CuidarRespuesta => ({ costo_visible: costo, en_vivo_al: '2026-10-09T18:00:00.000Z' } as unknown as CuidarRespuesta);

function montar(foto: { payload: unknown; calculado_at: Date } | undefined | 'sin_tabla') {
  const sqls: Array<{ sql: string; binds: unknown[] }> = [];
  const trx = {
    raw: vi.fn(async (sql: string, binds: unknown[] = []) => {
      sqls.push({ sql, binds });
      if (sql.includes('FROM analytics.product_flow_watch')) {
        if (foto === 'sin_tabla') throw new Error('relation "analytics.product_flow_watch" does not exist');
        return { rows: foto ? [foto] : [] };
      }
      return { rows: [] };
    }),
  };
  const tk = { run: vi.fn(async (a: unknown, b?: unknown) => (typeof a === 'function' ? (a as (t: unknown) => unknown)(trx) : (b as (t: unknown) => unknown)(trx))) };
  const latidos: Array<Record<string, unknown>> = [];
  const knex = Object.assign(vi.fn(() => ({
    insert: (row: Record<string, unknown>) => { latidos.push(row); return { onConflict: () => ({ merge: async () => undefined }) }; },
  })), { fn: { now: () => 'now()' } });
  const tenantCtx = { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' };
  const svc = new ProductFlowService(tk as never, tenantCtx as never, knex as never);
  const calcular = vi.spyOn(svc as unknown as { calcularCuidar: (...a: unknown[]) => Promise<Map<boolean, CuidarRespuesta>> }, 'calcularCuidar')
    .mockImplementation(async (_trx, variantes) => new Map((variantes as boolean[]).map((v) => [v, RESP(v)])));
  return { svc, sqls, calcular, latidos, tk };
}

describe('[PF.6] Para cuidar hoy: la foto del worker', () => {
  it('⭐ con foto reciente la sirve, sin calcular, y dice que es la foto y de cuándo', async () => {
    const at = new Date(Date.now() - 40_000);
    const { svc, calcular } = montar({ payload: RESP(true), calculado_at: at });
    const r = await svc.cuidar({ puedeVerCosto: true });
    expect(calcular).not.toHaveBeenCalled();
    expect(r.origen).toEqual({ fuente: 'foto', calculado_at: at.toISOString() });
  });

  it('pide la variante que toca: sin permiso de costo, la foto sin costo', async () => {
    const { svc, sqls } = montar({ payload: RESP(false), calculado_at: new Date() });
    await svc.cuidar({ puedeVerCosto: false });
    expect(sqls.find((s) => s.sql.includes('product_flow_watch'))?.binds).toEqual(['sin_costo']);
  });

  it('⛔ con la foto vieja (más de 3 min) calcula en vivo, sólo la variante pedida, y lo dice', async () => {
    const { svc, calcular } = montar({ payload: RESP(true), calculado_at: new Date(Date.now() - 4 * 60_000) });
    const r = await svc.cuidar({ puedeVerCosto: true });
    expect(calcular).toHaveBeenCalledTimes(1);
    expect(calcular.mock.calls[0][1]).toEqual([true]);
    expect(r.origen?.fuente).toBe('en_vivo');
  });

  it('[negativa] sin la tabla (antes de aplicar la migración) no truena: calcula en vivo', async () => {
    const { svc, calcular } = montar('sin_tabla');
    const r = await svc.cuidar({ puedeVerCosto: false });
    expect(calcular).toHaveBeenCalled();
    expect(r.origen?.fuente).toBe('en_vivo');
  });

  it('⭐ el worker calcula UNA vez las dos variantes, las guarda y deja su latido en verde', async () => {
    const { svc, calcular, sqls, latidos, tk } = montar(undefined);
    await svc.refrescarFoto();
    expect(calcular).toHaveBeenCalledTimes(1);
    expect(calcular.mock.calls[0][1]).toEqual([true, false]);
    expect(tk.run.mock.calls[0][0]).toBe('00000000-0000-0000-0000-00000000d01c');
    const escritas = sqls.filter((s) => s.sql.includes('INSERT INTO analytics.product_flow_watch')).map((s) => s.binds[0]);
    expect(escritas).toEqual(['costo', 'sin_costo']);
    expect(latidos[0]).toMatchObject({ job_key: 'product_flow_watch', status: 'ok', rows_affected: 2, error: null });
  });

  it('[negativa] si el cálculo falla, el latido queda en rojo con el error (no un verde mudo)', async () => {
    const { svc, calcular, latidos } = montar(undefined);
    calcular.mockRejectedValueOnce(new Error('boom'));
    await svc.refrescarFoto();
    expect(latidos[0]).toMatchObject({ job_key: 'product_flow_watch', status: 'error', rows_affected: 0, error: 'boom' });
  });

  it('una pasada lenta no se encima con la siguiente', async () => {
    const { svc, calcular } = montar(undefined);
    let soltar: () => void = () => undefined;
    calcular.mockImplementationOnce(() => new Promise((res) => { soltar = () => res(new Map([[true, RESP(true)], [false, RESP(false)]])); }));
    const primera = svc.refrescarFoto();
    await new Promise((r) => setTimeout(r, 0));
    await svc.refrescarFoto();
    soltar();
    await primera;
    expect(calcular).toHaveBeenCalledTimes(1);
  });
});
