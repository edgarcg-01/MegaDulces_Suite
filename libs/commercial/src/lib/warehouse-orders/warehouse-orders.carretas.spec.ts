import { WarehouseOrdersService } from './warehouse-orders.service';
import type { WarehouseOrderRow } from '@megadulces/contracts';

/**
 * `[GP.11.5]` El Tablero dice qué carretas trae cada pedido: Kepler por la MISMA clave que el piso
 * (`<sucursal>-<serie>-<folio>`), preventa por `order_id`. Una consulta para todas las filas.
 */

const fila = (p: Partial<WarehouseOrderRow>): WarehouseOrderRow => ({ clave: '01-1-0002840', order_id: null, carretas: [], ...p }) as WarehouseOrderRow;

function conOcupaciones(rows: unknown[]) {
  const svc = new WarehouseOrdersService({} as never, {} as never, {} as never);
  const raw = vi.fn(async () => ({ rows }));
  const poner = (filas: WarehouseOrderRow[]) =>
    (svc as unknown as { ponerCarretas: (t: unknown, f: WarehouseOrderRow[]) => Promise<void> }).ponerCarretas({ raw }, filas);
  return { poner, raw };
}

describe('[GP.11.5] Tablero · carretas por pedido', () => {
  it('⭐ Kepler por su clave y preventa por su order_id; un pedido con dos carretas las trae en orden', async () => {
    const { poner, raw } = conOcupaciones([
      { source: 'kepler', order_id: 'x', sucursal: '01', serie: 1, folio: '0002840', code: 'C03' },
      { source: 'kepler', order_id: 'x', sucursal: '01', serie: '1', folio: '0002840', code: 'C08' },
      { source: 'suite', order_id: 'pd-1', sucursal: null, serie: null, folio: null, code: 'C11' },
    ]);
    const k = fila({ clave: '01-1-0002840' });
    const pd = fila({ clave: '01-PD-PD-000123', order_id: 'pd-1' });
    const otra = fila({ clave: '01-1-0009999' });
    await poner([k, pd, otra]);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(k.carretas).toEqual(['C03', 'C08']);
    expect(pd.carretas).toEqual(['C11']);
    expect(otra.carretas).toEqual([]);
  });

  it('NEGATIVA: el order_id de una ocupación de Kepler no se confunde con el de un pedido de preventa', async () => {
    const { poner } = conOcupaciones([{ source: 'kepler', order_id: 'pd-1', sucursal: '06', serie: 1, folio: '1', code: 'C01' }]);
    const pd = fila({ clave: '01-PD-PD-000123', order_id: 'pd-1' });
    await poner([pd]);
    expect(pd.carretas).toEqual([]);
  });
});
