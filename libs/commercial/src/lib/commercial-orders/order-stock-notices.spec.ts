import { declararPendientesViejas, filasDelGrupo, marcaDeVersion, MINUTOS_PARA_DECLARAR, MOTIVO_BARRIDO } from './order-stock-notices';

/**
 * `[DN.8]` Las piezas puras del registro de lo negado: cómo se copia el renglón a la fila (la llave, la
 * cantidad en base y en su presentación) y cómo se sanea la versión de la app. El SQL se prueba contra
 * base real (`database/tests/test-newdb-dn-registro-negado.js`).
 */
const R = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const P = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const W1 = 'cccccccc-0000-4000-8000-0000000000c1';
const W2 = 'cccccccc-0000-4000-8000-0000000000c2';

const renglon = (p: Record<string, unknown> = {}) => ({
  line_id: 'l1', order_id: R, product_id: P, quantity: 24, qty_unit: 'CJA', qty_factor: 12, unit_price: 9.5, line_total: 264.48,
  source_warehouse_id: W1, order_warehouse_id: W1, customer_id: 'c1', user_id: 'u1', requested_delivery_date: '2030-01-02', root_order_id: R,
  ...p,
}) as Parameters<typeof filasDelGrupo>[0][number];

describe('[DN.8] filasDelGrupo — la copia del original', () => {
  it('⭐ la cantidad en BASE y en su PRESENTACIÓN (24 base = 2 CJA)', () => {
    const [f] = filasDelGrupo([renglon()]);
    expect(f).toMatchObject({ quantity: 24, qty_unit: 'CJA', qty_factor: 12, unit_quantity: 2, root_order_id: R, order_line_id: 'l1' });
  });

  it('sin unidad (sincronizado sin conexión): la presentación queda en null, nunca se rellena con la base', () => {
    const [f] = filasDelGrupo([renglon({ qty_unit: null, qty_factor: null })]);
    expect(f).toMatchObject({ quantity: 24, qty_unit: null, qty_factor: null, unit_quantity: null });
  });

  it('una fila por llave (pedido, producto, sucursal): el mismo producto de dos sucursales son dos filas', () => {
    const fs = filasDelGrupo([renglon(), renglon({ line_id: 'l2', source_warehouse_id: W2, order_id: 'parte' })]);
    expect(fs.map((f) => f.source_warehouse_id)).toEqual([W1, W2]);
    expect(fs[1].order_id).toBe('parte');
  });

  it('⭐ el mismo producto y sucursal en DOS pedidos del grupo son dos filas (no se pisan: son dos demandas)', () => {
    const fs = filasDelGrupo([renglon(), renglon({ line_id: 'l2', order_id: 'otra-parte', quantity: 12 })]);
    expect(fs).toHaveLength(2);
    expect(fs.map((f) => f.order_id)).toEqual([R, 'otra-parte']);
    expect(fs.map((f) => f.quantity)).toEqual([24, 12]);
  });

  it('⭐ dos renglones con la MISMA llave se suman; con unidades distintas la presentación se declara null (no se suman PAQ con CJA)', () => {
    const [mismas] = filasDelGrupo([renglon(), renglon({ line_id: 'l2' })]);
    expect(mismas).toMatchObject({ quantity: 48, qty_unit: 'CJA', unit_quantity: 4 });
    const [mezcla] = filasDelGrupo([renglon(), renglon({ line_id: 'l2', quantity: 5, qty_unit: 'PAQ', qty_factor: 5 })]);
    expect(mezcla).toMatchObject({ quantity: 29, qty_unit: null, qty_factor: null, unit_quantity: null });
  });

  it('los numéricos que llegan como texto (Postgres numeric) se leen como número', () => {
    const [f] = filasDelGrupo([renglon({ quantity: '24.000' as never, qty_factor: '12.0000' as never, unit_price: '9.5000' as never })]);
    expect(f).toMatchObject({ quantity: 24, qty_factor: 12, unit_price: 9.5, unit_quantity: 2 });
  });
});

describe('[DN.8] marcaDeVersion — la versión de la app, saneada', () => {
  it('acepta la marca de la app', () => {
    expect(marcaDeVersion('vendor@2026-11-07.dn11a')).toBe('vendor@2026-11-07.dn11a');
    expect(marcaDeVersion('  vendor:1.2_3  ')).toBe('vendor:1.2_3');
  });

  it('negativa: texto libre, vacío, demasiado largo o que no es texto → null', () => {
    for (const v of ['vendor; DROP TABLE x', '', '   ', 'x'.repeat(61), 42, null, undefined, { v: 1 }]) {
      expect(marcaDeVersion(v)).toBeNull();
    }
  });
});

describe('[DN.8] el barrido (declararPendientesViejas)', () => {
  /** Un doble de knex que anota la consulta que se arma. El SQL real se prueba contra base. */
  function dobleTrx(cambiadas: number) {
    const vista: { tabla?: string; where?: unknown; whereRaw?: [string, unknown[]]; update?: unknown } = {};
    const q: Record<string, unknown> = {};
    q['where'] = (o: unknown) => { vista.where = o; return q; };
    q['whereRaw'] = (sql: string, b: unknown[]) => { vista.whereRaw = [sql, b]; return q; };
    q['update'] = async (p: unknown) => { vista.update = p; return cambiadas; };
    const trx = Object.assign((t: string) => { vista.tabla = t; return q; }, { fn: { now: () => 'AHORA' } });
    return { trx: trx as unknown as Parameters<typeof declararPendientesViejas>[0], vista };
  }

  it('⭐ pasa a sin_dato SÓLO lo pendiente más viejo que el umbral, en MINUTOS, con su motivo', async () => {
    const { trx, vista } = dobleTrx(3);
    expect(await declararPendientesViejas(trx, 10)).toBe(3);
    expect(vista.tabla).toBe('commercial.order_stock_notices');
    expect(vista.where).toEqual({ stock_state: 'pendiente' });
    expect(vista.whereRaw).toEqual(['created_at < now() - make_interval(mins => ?::int)', [10]]);
    expect(vista.update).toEqual({ stock_state: 'sin_dato', stock_reason: MOTIVO_BARRIDO, updated_at: 'AHORA' });
    // El motivo dice qué pasó; nunca «no había».
    expect(MOTIVO_BARRIDO).not.toMatch(/no hab[ií]a|agotad/i);
  });

  it('el umbral por omisión es MINUTOS_PARA_DECLARAR (10)', async () => {
    const { trx, vista } = dobleTrx(0);
    expect(await declararPendientesViejas(trx)).toBe(0);
    expect(MINUTOS_PARA_DECLARAR).toBe(10);
    expect(vista.whereRaw?.[1]).toEqual([10]);
  });
});
