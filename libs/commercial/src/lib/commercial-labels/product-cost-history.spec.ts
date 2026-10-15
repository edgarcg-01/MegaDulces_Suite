import { ProductCostHistoryService, SQL_FOTO_COSTO } from './product-cost-history.service';
import { CommercialLabelsService } from './commercial-labels.service';

/**
 * `[ETQ-CAMBIOS.11]` La foto diaria del costo (worker) y el «costo anterior» que sale de ella.
 *
 * ⚠️ Estas pruebas simulan la base: NO prueban el SQL. El SQL se ejerce contra una base real con
 * `database/scripts/verificar-cambios-compras.js` (sólo lectura) antes de darlo por bueno.
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

function montarFoto(resultado: { vigentes: number; insertadas: number } | Error) {
  const sqls: string[] = [];
  const trx = {
    raw: vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('INSERT INTO analytics.product_cost_history')) {
        if (resultado instanceof Error) throw resultado;
        return { rows: [{ vigentes: String(resultado.vigentes), insertadas: String(resultado.insertadas) }] };
      }
      return { rows: [] };
    }),
  };
  const tk = { run: vi.fn(async (_t: string, cb: (t: unknown) => unknown) => cb(trx)) };
  const latidos: Array<Record<string, unknown>> = [];
  const knex = Object.assign(vi.fn(() => ({
    insert: (row: Record<string, unknown>) => { latidos.push(row); return { onConflict: () => ({ merge: async () => undefined }) }; },
  })), { fn: { now: () => 'now()' } });
  return { svc: new ProductCostHistoryService(tk as never, knex as never), sqls, latidos, tk };
}

describe('[ETQ-CAMBIOS.11] la foto diaria del costo', () => {
  it('⭐ corre en el tenant de Mega Dulces y deja el latido en verde con las filas NUEVAS', async () => {
    const { svc, latidos, tk } = montarFoto({ vigentes: 5000, insertadas: 37 });
    const r = await svc.tomarFoto();
    expect(r).toEqual({ vigentes: 5000, insertadas: 37 });
    expect(tk.run.mock.calls[0][0]).toBe(MEGA);
    expect(latidos[0]).toMatchObject({ job_key: 'product_cost_history', status: 'ok', rows_affected: 37, error: null });
  });

  it('cero filas nuevas es NORMAL (ningún costo cambió): el latido sigue verde', async () => {
    const { svc, latidos } = montarFoto({ vigentes: 5000, insertadas: 0 });
    await svc.tomarFoto();
    expect(latidos[0]).toMatchObject({ status: 'ok', rows_affected: 0 });
  });

  it('⛔ [negativa] si la vista no devolvió NINGÚN costo es falla aunque no haya excepción', async () => {
    const { svc, latidos } = montarFoto({ vigentes: 0, insertadas: 0 });
    await svc.tomarFoto();
    expect(latidos[0]).toMatchObject({ status: 'error' });
    expect(String(latidos[0].error)).toContain('no devolvió ningún costo');
  });

  it('⛔ [negativa] si el SQL truena, el latido queda en rojo con el error (no un verde mudo)', async () => {
    const { svc, latidos } = montarFoto(new Error('boom'));
    expect(await svc.tomarFoto()).toBeNull();
    expect(latidos[0]).toMatchObject({ job_key: 'product_cost_history', status: 'error', rows_affected: 0, error: 'boom' });
  });

  it('el SQL sólo inserta lo que CAMBIÓ y no repite una llave dentro de la misma pasada', () => {
    expect(SQL_FOTO_COSTO).toContain('u.costo_sin_impuesto IS NULL OR u.costo_sin_impuesto <> round(v.costo::numeric, 4)');
    expect(SQL_FOTO_COSTO).toContain('DISTINCT ON (sucursal, sku, unidad)');
    // sólo costos positivos, en los tres peldaños: un costo cero no es un costo
    expect(SQL_FOTO_COSTO.match(/costo_estandar(_u2|_u3)?\s+> 0/g)).toHaveLength(3);
    // los tres peldaños de la ficha
    for (const c of ['unidad_base', 'unidad_dos', 'unidad_tres']) expect(SQL_FOTO_COSTO).toContain(c);
  });
});

describe('[ETQ-CAMBIOS.11] las fichas de Compras de la lista de cambios', () => {
  type Fila = Record<string, unknown>;
  function montarFichas(opts: { historia?: Fila[] | 'sin_tabla'; costos?: Fila[] }) {
    const trx: Record<string, unknown> = {
      raw: vi.fn(async (sql: string) => {
        if (sql.includes('FROM catalog.products')) return { rows: [{ sku: '91059', proveedor: 'MONDELEZ MEXICO' }, { sku: '95459', proveedor: 'PRODUCTOS SIN PROVEEDOR' }] };
        if (sql.includes('analytics.v_label_prices')) return { rows: [{ sku: '91059', box_size: '12', box_price: '6378.26' }] };
        if (sql.includes('analytics.v_kepler_standard_cost')) return { rows: opts.costos ?? [] };
        return { rows: [] };
      }),
    };
    // El savepoint: reproduce knex (`trx.transaction(cb)`) con su propio `raw`.
    trx.transaction = async (cb: (sp: unknown) => unknown) => cb({
      raw: async (sql: string) => {
        if (opts.historia === 'sin_tabla') throw new Error('relation "analytics.product_cost_history" does not exist');
        if (sql.includes('min(valid_from)')) return { rows: [{ desde: '2026-10-15' }] };
        return { rows: opts.historia ?? [] };
      },
    });
    const svc = new CommercialLabelsService({} as never);
    const f = (svc as unknown as { fichasCompras: (t: unknown, s: string, k: string[]) => Promise<{ fichas: Array<Record<string, unknown>>; historial_desde: string | null }> })
      .fichasCompras.bind(svc);
    return () => f(trx, '01', ['91059', '95459', '77777']);
  }
  const COSTO: Fila = {
    sku: '91059', unidad_base: 'PZA', unidad_dos: null, unidad_tres: 'CJA',
    costo_estandar: '10', costo_estandar_u2: null, costo_estandar_u3: '120', impuesto_pct: '16',
  };

  it('⭐ trae proveedor, UXC y mayoreo (precio de la caja) y elige el costo anterior de la historia', async () => {
    const run = montarFichas({
      costos: [COSTO],
      historia: [
        { sku: '91059', unidad: 'CJA', costo: 100, desde: '2026-10-15' },
        { sku: '91059', unidad: 'CJA', costo: 90, desde: '2026-10-01' },
      ],
    });
    const r = await run();
    const f = r.fichas.find((x) => x.sku === '91059')!;
    expect(f).toMatchObject({ proveedor: 'MONDELEZ MEXICO', uxc: 12, mayoreo_caja: 6378.26, impuesto_pct: 16 });
    const costos = f.costos as Array<{ unidad: string; costo_actual: number; costo_anterior: number | null }>;
    // CJA: hoy 120, última foto 100 ≠ 120 → el anterior es la última foto. PZA: sin historia → sin anterior.
    expect(costos.find((c) => c.unidad === 'CJA')).toMatchObject({ costo_actual: 120, costo_anterior: 100 });
    expect(costos.find((c) => c.unidad === 'PZA')).toMatchObject({ costo_actual: 10, costo_anterior: null });
    expect(r.historial_desde).toBe('2026-10-15');
  });

  it('⛔ todo código de la lista sale con ficha aunque no tenga costo; el proveedor comodín cuenta como sin proveedor', async () => {
    const r = await montarFichas({ costos: [COSTO], historia: [] })();
    expect(r.fichas.map((x) => x.sku)).toEqual(['91059', '95459', '77777']);
    const sin = r.fichas.find((x) => x.sku === '95459')!;
    expect(sin).toMatchObject({ proveedor: null, uxc: null, mayoreo_caja: null, impuesto_pct: null, costos: [] });
  });

  it('⛔ [negativa] sin la tabla de historia (migración sin aplicar) la lista NO se cae: sin anterior y sin fecha', async () => {
    const r = await montarFichas({ costos: [COSTO], historia: 'sin_tabla' })();
    const f = r.fichas.find((x) => x.sku === '91059')!;
    const costos = f.costos as Array<{ costo_anterior: number | null }>;
    expect(costos.every((c) => c.costo_anterior === null)).toBe(true);
    expect(r.historial_desde).toBeNull();
    // error ≠ vacío: se AVISA que no se pudo leer, no se hace pasar por «todavía no hay foto»
    expect(r.historial_error).toBe(true);
  });

  it('con la tabla vacía NO es error: es «todavía no hay foto»', async () => {
    const r = await montarFichas({ costos: [COSTO], historia: [] })();
    expect(r.historial_error).toBe(false);
  });
});
