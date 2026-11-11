import { BadRequestException } from '@nestjs/common';
import { DatosPlaza, LoteCaducidad, LoteFila, juzgarLotes, juzgarPlaza, periodos } from './product-flow';
import { escaleraDeFicha } from './new-products';
import { ProductFlowService } from './product-flow.service';

/**
 * `[CE.3.1]` «Por vencer» reusa `juzgarLotes` (no lo reimplementa, ADR-056): el juicio de cada lote viaja con el
 * id de su renglón en `commercial.stock_lots` y se pide en UNA pasada para los productos de la lista.
 */
const HOY = '2026-10-09';
const P = periodos(HOY);
const ESC = escaleraDeFicha({ u1: 'PZA', u2: null, u3: 'CJA', f2: null, f3: '12', uxc: '12' });
const NOMBRES = new Map([['01', 'Padre Hidalgo'], ['02', 'La Piedad Abastos']]);
const plaza = (plazaCode: string, diaria: number, existencia: number | null, over: Partial<DatosPlaza> = {}) => juzgarPlaza(P, {
  plaza: plazaCode, nombre: NOMBRES.get(plazaCode) ?? null,
  mes: diaria * 10 * P.dias, mes_anterior_mismo: diaria * 10 * P.dias, mes_anterior_total: diaria * 10 * 30,
  monto30: diaria * 10 * 30, unidades30: diaria * 30, ultima: diaria > 0 ? HOY : null,
  existencia, duda: null, escalera: ESC, costo: null, ...over,
});
const lote = (plazaCode: string, caduca: string, cantidad: number, lotId?: string): LoteFila =>
  ({ product_id: 'p', plaza: plazaCode, lote: 'L1', caduca, cantidad, registrado: '2026-09-01', lot_id: lotId });

describe('[CE.3.1] juzgarLotes lleva el id del renglón', () => {
  it('⭐ cada lote juzgado dice de qué renglón de stock_lots salió (aunque el orden cambie)', () => {
    const ls = juzgarLotes(P, [lote('01', '2027-06-01', 10, 'lot-b'), lote('01', '2026-10-29', 300, 'lot-a')],
      [plaza('01', 10, 310), plaza('02', 20, 40)], NOMBRES);
    const porId = new Map(ls.map((l) => [l.lot_id, l]));
    expect(porId.get('lot-a')).toMatchObject({ caduca: '2026-10-29', estado: 'no_alcanza' });
    expect(porId.get('lot-a')!.mover_a).toEqual([{ plaza: '02', nombre: 'La Piedad Abastos', cantidad: 100 }]);
    expect(porId.get('lot-b')).toMatchObject({ caduca: '2027-06-01', estado: 'a_tiempo' });
  });

  it('una fila sin id (el flujo de siempre) da lot_id NULL, no inventa uno', () => {
    const [l] = juzgarLotes(P, [lote('01', '2026-10-29', 50)], [plaza('01', 10, 50)], NOMBRES);
    expect(l.lot_id).toBeNull();
  });
});

describe('[CE.3.1] ProductFlowService.juicioLotes', () => {
  const LOTE: LoteCaducidad = {
    lot_id: 'lot-a', plaza: '01', nombre: 'Padre Hidalgo', lote: 'L1', caduca: '2026-10-29', dias: 20, registrado: 300,
    en_existencia: 300, se_vende_antes: 200, queda: 100, estado: 'no_alcanza', accion: 'mover', mover_a: [], sin_destino: 0, escalera: null,
  };
  const ID1 = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';

  function montar() {
    const trx = {};
    const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
    const svc = new ProductFlowService(tk as never, {} as never, {} as never);
    const base = vi.spyOn(svc as unknown as { base: () => Promise<unknown> }, 'base')
      .mockResolvedValue({ hoy: HOY, corte: '2026-10-08', p: P });
    const resumenes = vi.spyOn(svc as unknown as { resumenes: (...a: unknown[]) => Promise<unknown> }, 'resumenes')
      .mockImplementation(async (_trx, _p, _corte, ids, _variantes, extra) => {
        const cb = (extra as { alJuzgarLotes: (id: string, ls: LoteCaducidad[]) => void }).alJuzgarLotes;
        for (const id of ids as string[]) cb(id, id === ID1 ? [LOTE] : []);
        return new Map();
      });
    return { svc, base, resumenes };
  }

  it('⭐ una sola pasada, SIN costo, y cada producto con sus lotes juzgados', async () => {
    const { svc, resumenes } = montar();
    const r = await svc.juicioLotes([ID1, ID2, ID1, 'no-es-uuid']);
    expect(resumenes).toHaveBeenCalledTimes(1);
    expect(resumenes.mock.calls[0][3]).toEqual([ID1, ID2]);
    // [false] = la variante sin costo: el juicio no lo usa y quien entra por inventario no lo ve.
    expect(resumenes.mock.calls[0][4]).toEqual([false]);
    expect(r.productos).toEqual([{ product_id: ID1, lotes: [LOTE] }, { product_id: ID2, lotes: [] }]);
    expect(r.caducidad_aviso).toBeGreaterThan(0);
    expect(r.periodos.hoy).toBe(HOY);
  });

  it('sin ids válidos no calcula nada y responde vacío', async () => {
    const { svc, resumenes } = montar();
    const r = await svc.juicioLotes(['', 'x']);
    expect(resumenes).not.toHaveBeenCalled();
    expect(r.productos).toEqual([]);
  });

  it('[negativa] más de 200 productos se rechaza (como la lista del flujo)', async () => {
    const { svc } = montar();
    const ids = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(svc.juicioLotes(ids)).rejects.toBeInstanceOf(BadRequestException);
  });
});
