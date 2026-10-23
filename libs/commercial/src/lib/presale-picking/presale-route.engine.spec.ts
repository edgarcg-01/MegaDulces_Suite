import { CierreInvalido } from './presale-picking.engine';
import {
  PEDIDO_EN_RUTA_SQL, consolidar, etiquetaSucursal, otrasSucursales, repartirRuta, surtidoVisto,
  type RenglonDeRuta, type SurtidoDeSucursal, type SurtidoLegado,
} from './presale-route.engine';

/**
 * `[MCP.3.6]` El pedido global de la ruta, sin base. Lo que se prueba es lo que se puede romper sin
 * que la pantalla cambie de aspecto: el total de cada producto (y en qué unidad), y a quién se le
 * quita cuando no alcanzó.
 */
let n = 0;
function renglon(p: Partial<RenglonDeRuta> & { order_id: string }): RenglonDeRuta {
  n++;
  return {
    code: `PD-${p.order_id}`, customer_name: `Cliente ${p.order_id}`, confirmed_at: '2026-10-21T15:00:00Z', delivery_date: '2026-10-22',
    line_id: `l${n}`, product_id: 'paleta', sku: 'SKU-1', barcode: null, product_name: 'PALETA PAYASO', brand: 'RICOLINO',
    quantity: 30, qty_unit: null, qty_factor: null,
    ...p,
  };
}

describe('consolidar · un renglón por producto', () => {
  it('suma en la unidad común y dice a quién le toca', () => {
    const rs = [
      renglon({ order_id: 'A', quantity: 24, qty_unit: 'PAQ', qty_factor: 12 }),
      renglon({ order_id: 'B', quantity: 36, qty_unit: 'PAQ', qty_factor: 12 }),
    ];
    const [p] = consolidar(rs);
    expect(p).toMatchObject({ product_id: 'paleta', qty: 5, unit: 'PAQ', factor: 12, base_qty: 60 });
    expect(p.clients).toEqual([
      { order_id: 'A', code: 'PD-A', customer_name: 'Cliente A', qty: 2, unit: 'PAQ' },
      { order_id: 'B', code: 'PD-B', customer_name: 'Cliente B', qty: 3, unit: 'PAQ' },
    ]);
  });

  it('con unidades mezcladas (PAQ y CJA) el total va en piezas', () => {
    const rs = [
      renglon({ order_id: 'A', quantity: 24, qty_unit: 'PAQ', qty_factor: 12 }),
      renglon({ order_id: 'B', quantity: 48, qty_unit: 'CJA', qty_factor: 48 }),
    ];
    const [p] = consolidar(rs);
    expect(p).toMatchObject({ qty: 72, unit: 'PZA', factor: 1, base_qty: 72 });
    // Cada cliente sigue viendo lo que pidió, en su unidad.
    expect(p.clients.map((c) => `${c.qty} ${c.unit}`)).toEqual(['2 PAQ', '1 CJA']);
  });

  it('ordena por marca y nombre, y lo que no tiene marca va al final', () => {
    const rs = [
      renglon({ order_id: 'A', product_id: 'x', product_name: 'ZAPATITO', brand: null }),
      renglon({ order_id: 'A', product_id: 'y', product_name: 'MAZAPÁN', brand: 'DE LA ROSA' }),
      renglon({ order_id: 'A', product_id: 'z', product_name: 'BOMBÓN', brand: 'DE LA ROSA' }),
      renglon({ order_id: 'A', product_id: 'w', product_name: 'AAA', brand: 'ZETA' }),
    ];
    expect(consolidar(rs).map((p) => p.product_name)).toEqual(['BOMBÓN', 'MAZAPÁN', 'AAA', 'ZAPATITO']);
  });
});

describe('repartirRuta · lo que se encontró, entre los clientes', () => {
  const tres = () => [
    renglon({ order_id: 'A', confirmed_at: '2026-10-21T15:00:00Z' }),
    renglon({ order_id: 'B', confirmed_at: '2026-10-21T15:10:00Z' }),
    renglon({ order_id: 'C', confirmed_at: '2026-10-21T15:20:00Z' }),
  ];

  it('90 paletas para 3 clientes y se encontraron 80: los dos primeros reciben 30 y el tercero 20', () => {
    const rs = tres();
    const productos = consolidar(rs);
    expect(productos[0]).toMatchObject({ qty: 90, unit: 'PZA' });
    const r = repartirRuta(productos, rs, [{ product_id: 'paleta', picked: 80 }]);
    expect(r.map((c) => [c.order_id, c.marcados[0].picked, c.sin_mercancia])).toEqual([
      ['A', 30, false], ['B', 30, false], ['C', 20, false],
    ]);
  });

  it('el orden lo decide la confirmación, no el orden en que llegan los renglones', () => {
    const rs = tres().reverse();
    const r = repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 80 }]);
    const de = Object.fromEntries(r.map((c) => [c.order_id, c.marcados[0].picked]));
    expect(de).toEqual({ A: 30, B: 30, C: 20 });
  });

  it('con unidades mezcladas reparte en piezas y devuelve a cada renglón en su unidad', () => {
    const rs = [
      renglon({ order_id: 'A', quantity: 24, qty_unit: 'PAQ', qty_factor: 12, confirmed_at: '2026-10-21T15:00:00Z' }),
      renglon({ order_id: 'B', quantity: 48, qty_unit: 'CJA', qty_factor: 48, confirmed_at: '2026-10-21T15:10:00Z' }),
    ];
    // 60 piezas: A recibe sus 2 PAQ (24) y a B le tocan 36, que no llegan a 1 CJA.
    const r = repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 60 }]);
    expect(r.map((c) => [c.order_id, c.marcados[0].picked, c.sin_mercancia])).toEqual([
      ['A', 2, false], ['B', 0, true],
    ]);
  });

  it('un pedido al que no le tocó nada en ningún renglón queda sin_mercancia', () => {
    const rs = [
      renglon({ order_id: 'A', product_id: 'paleta' }),
      renglon({ order_id: 'A', product_id: 'chicle', product_name: 'CHICLE' }),
      renglon({ order_id: 'B', product_id: 'paleta', confirmed_at: '2026-10-21T16:00:00Z' }),
    ];
    const r = repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 30 }, { product_id: 'chicle', picked: 30 }]);
    const de = Object.fromEntries(r.map((c) => [c.order_id, c]));
    expect(de['A'].sin_mercancia).toBe(false);
    expect(de['A'].marcados.map((m) => m.picked)).toEqual([30, 30]);
    expect(de['B'].sin_mercancia).toBe(true);
    expect(de['B'].marcados).toEqual([{ line_id: rs[2].line_id, picked: 0 }]);
  });

  it('dos renglones del mismo producto en el mismo pedido no se pisan', () => {
    const rs = [renglon({ order_id: 'A', quantity: 10 }), renglon({ order_id: 'A', quantity: 5 })];
    const r = repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 12 }]);
    expect(r[0].marcados.map((m) => m.picked)).toEqual([10, 2]);
  });

  it('encontrar más de lo pedido es un error', () => {
    const rs = tres();
    expect(() => repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 91 }])).toThrow(CierreInvalido);
  });

  it('si falta un producto por marcar es un error', () => {
    const rs = [renglon({ order_id: 'A' }), renglon({ order_id: 'A', product_id: 'chicle', product_name: 'CHICLE' })];
    expect(() => repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 30 }])).toThrow(/Falta marcar «CHICLE»/);
  });

  it('un producto ajeno, repetido o con fracción en piezas es un error', () => {
    const rs = tres();
    const ps = consolidar(rs);
    expect(() => repartirRuta(ps, rs, [{ product_id: 'paleta', picked: 1 }, { product_id: 'otro', picked: 1 }])).toThrow(/no es de esta ruta/);
    expect(() => repartirRuta(ps, rs, [{ product_id: 'paleta', picked: 1 }, { product_id: 'paleta', picked: 1 }])).toThrow(/repetido/);
    expect(() => repartirRuta(ps, rs, [{ product_id: 'paleta', picked: 1.5 }])).toThrow(/entera/);
    expect(() => repartirRuta(ps, rs, [{ product_id: 'paleta', picked: -1 }])).toThrow(/inválida/);
  });

  it('en KG sí hay fracción, redondeada a milésimas', () => {
    const rs = [
      renglon({ order_id: 'A', quantity: 2.5, qty_unit: 'KG', qty_factor: null }),
      renglon({ order_id: 'B', quantity: 2, qty_unit: 'KG', qty_factor: null, confirmed_at: '2026-10-21T16:00:00Z' }),
    ];
    const r = repartirRuta(consolidar(rs), rs, [{ product_id: 'paleta', picked: 3.25 }]);
    expect(r.map((c) => c.marcados[0].picked)).toEqual([2.5, 0.75]);
  });
});

describe('PEDIDO_EN_RUTA_SQL · la ventana de la ruta', () => {
  it('acota por persona, por la ventana de inicio a fin y por el día de trabajo', () => {
    expect(PEDIDO_EN_RUTA_SQL).toMatch(/rd\.user_id = o\.user_id/);
    expect(PEDIDO_EN_RUTA_SQL).toMatch(/o\.confirmed_at >= rd\.started_at/);
    expect(PEDIDO_EN_RUTA_SQL).toMatch(/rd\.finished_at IS NULL OR o\.confirmed_at <= rd\.finished_at/);
    expect(PEDIDO_EN_RUTA_SQL).toMatch(/= rd\.work_date/);
    expect(PEDIDO_EN_RUTA_SQL).toMatch(/rd\.deleted_at IS NULL/);
  });
});

// ───────────────────────────── [MCP.3.13] por sucursal ─────────────────────────────

const SIN_LEGADO: SurtidoLegado = {
  pick_started_by: null, pick_started_by_name: null, pick_started_at: null,
  pick_finished_by: null, pick_finished_by_name: null, pick_finished_at: null,
};
const suc = (warehouse_id: string, p: Partial<SurtidoDeSucursal> = {}): SurtidoDeSucursal => ({
  warehouse_id, pick_started_by: 'u-' + warehouse_id, pick_started_by_name: 'Surtidor ' + warehouse_id,
  pick_started_at: '2026-10-23T18:00:00Z', pick_finished_by: null, pick_finished_by_name: null, pick_finished_at: null, ...p,
});
const terminada = (warehouse_id: string, at: string, p: Partial<SurtidoDeSucursal> = {}) =>
  suc(warehouse_id, { pick_finished_by: 'u-' + warehouse_id, pick_finished_by_name: 'Surtidor ' + warehouse_id, pick_finished_at: at, ...p });

describe('[MCP.3.13] surtidoVisto · el estado de la ruta para MIS sucursales', () => {
  it('sin filas por sucursal manda el dueño único de siempre (rutas surtidas antes del cambio)', () => {
    const v = surtidoVisto(
      { ...SIN_LEGADO, pick_started_by: 'ana', pick_started_by_name: 'Ana', pick_started_at: '2026-10-22T18:00:00Z',
        pick_finished_by: 'ana', pick_finished_by_name: 'Ana', pick_finished_at: '2026-10-22T19:00:00Z' },
      ['lpa'], [],
    );
    expect(v.started).toMatchObject({ by: 'ana' });
    expect(v.finished).toMatchObject({ by: 'ana', at: '2026-10-22T19:00:00Z' });
  });

  it('sin filas ni dueño viejo: nada empezado', () => {
    expect(surtidoVisto(SIN_LEGADO, ['lpa'], [])).toEqual({ started: null, finished: null });
  });

  it('con filas, el dueño viejo ya no cuenta y sólo ven MIS sucursales', () => {
    const v = surtidoVisto({ ...SIN_LEGADO, pick_finished_at: '2026-10-22T19:00:00Z' }, ['lpa'], [terminada('ph', '2026-10-23T19:00:00Z')]);
    expect(v).toEqual({ started: null, finished: null });
  });

  it('mi sucursal abierta → empezada por quien la tiene, sin terminar', () => {
    const v = surtidoVisto(SIN_LEGADO, ['lpa'], [terminada('ph', '2026-10-23T19:00:00Z'), suc('lpa')]);
    expect(v.started).toMatchObject({ by: 'u-lpa' });
    expect(v.finished).toBeNull();
  });

  it('varias sucursales (modo dios): terminada sólo cuando TODAS terminaron, con la última hora', () => {
    const una = surtidoVisto(SIN_LEGADO, ['lpa', 'ph'], [terminada('ph', '2026-10-23T19:00:00Z')]);
    expect(una.finished).toBeNull();
    expect(una.started).toMatchObject({ by: 'u-ph' });
    const dos = surtidoVisto(SIN_LEGADO, ['lpa', 'ph'], [terminada('ph', '2026-10-23T19:00:00Z'), terminada('lpa', '2026-10-23T20:00:00Z')]);
    expect(dos.finished).toMatchObject({ by: 'u-lpa', at: '2026-10-23T20:00:00Z' });
  });
});

describe('[MCP.3.13] otrasSucursales · quién más surte partes de la ruta', () => {
  const parte = (group_id: string, warehouse_id: string, short_label: string | null, name: string) => ({ group_id, warehouse_id, short_label, name });

  it('las de mis grupos que no son mías, sin repetir y ordenadas', () => {
    const r = otrasSucursales(
      { group_ids: ['g1', 'g2'], warehouse_ids: ['lpa'] },
      [parte('g1', 'lpa', 'LPA', 'La Piedad Abastos'), parte('g1', 'ph', 'PH', 'Padre Hidalgo'), parte('g2', 'ph', 'PH', 'Padre Hidalgo'),
        parte('g2', 'cen', null, 'Centro'), parte('g9', 'zam', 'ZAM', 'Zamora')],
    );
    expect(r).toEqual(['Centro', 'PH']);
  });

  it('sin grupos: ninguna', () => {
    expect(otrasSucursales({ group_ids: [], warehouse_ids: ['lpa'] }, [parte('g1', 'ph', 'PH', 'Padre Hidalgo')])).toEqual([]);
  });

  it('la etiqueta es la corta y, si no hay, el nombre', () => {
    expect(etiquetaSucursal({ short_label: ' PH ', name: 'Padre Hidalgo' })).toBe('PH');
    expect(etiquetaSucursal({ short_label: '', name: 'Padre Hidalgo' })).toBe('Padre Hidalgo');
    expect(etiquetaSucursal({})).toBeNull();
  });
});
