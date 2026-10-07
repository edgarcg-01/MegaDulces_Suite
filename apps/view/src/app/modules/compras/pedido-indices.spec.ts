import { agruparPorProducto, filtrarPorTipo } from './pedido-indices';

/**
 * `[RA-PERF.7]` — el candado **cruza dos implementaciones**.
 *
 * El índice no se compara contra sí mismo (eso pasa en verde casi cualquier cosa; es la lección de
 * `[IC.0]`/`[IC.3]`), sino contra el `filter(...).sort(...)` ingenuo que viene a reemplazar. Si el
 * índice y el barrido no dicen exactamente lo mismo para TODOS los productos, esto se pone rojo:
 * la optimización no puede cambiar ni un renglón de lo que el comprador ve.
 */
interface Fila { product_id: string; type: string; warehouse_code: string; qty: number }

const ORDEN: Record<string, number> = { comprar: 0, traspaso: 1, sobre: 2 };
const CODIGOS = ['PH', 'MA', 'MM', '8ESQ', 'LPA', 'YUR', 'CAN', 'ZAM', 'CEDIS'];
const comparar = (a: Fila, b: Fila) =>
  ORDEN[a.type] - ORDEN[b.type] || CODIGOS.indexOf(a.warehouse_code) - CODIGOS.indexOf(b.warehouse_code);

/** La implementación ANTERIOR, tal cual estaba en el componente. Es el árbitro. */
const barridoIngenuo = (filas: Fila[], pid: string) =>
  filas.filter((f) => f.product_id === pid).sort(comparar);

/** Universo determinista con la forma real: N productos × 9 almacenes × 3 tipos. */
function universo(productos: number): Fila[] {
  const out: Fila[] = [];
  let n = 0;
  for (let p = 0; p < productos; p++) {
    for (const code of CODIGOS) {
      for (const type of ['sobre', 'comprar', 'traspaso']) {   // a propósito en DESORDEN
        n++;
        if (n % 7 === 0) continue;                             // huecos, como en los datos reales
        out.push({ product_id: 'P' + p, type, warehouse_code: code, qty: n });
      }
    }
  }
  return out;
}

describe('[RA-PERF.7] agruparPorProducto — mismo resultado que el barrido que reemplaza', () => {
  const filas = universo(40);
  const idx = agruparPorProducto(filas, comparar);

  it('el universo de prueba tiene la forma real (cientos de filas, varios productos)', () => {
    expect(filas.length).toBeGreaterThan(900);
    expect(idx.size).toBe(40);
  });

  it('⭐ para TODOS los productos, el índice y el barrido coinciden fila por fila', () => {
    for (const pid of idx.keys()) {
      expect(idx.get(pid)).toEqual(barridoIngenuo(filas, pid));
    }
  });

  it('el orden es acción → sucursal canónica, no el de llegada', () => {
    const g = idx.get('P0') ?? [];
    const tipos = g.map((f) => f.type);
    expect(tipos).toEqual([...tipos].sort((a, b) => ORDEN[a] - ORDEN[b]));
  });

  it('respeta la identidad de las filas (no copia): el qty editado se ve desde el índice', () => {
    const g = idx.get('P1') ?? [];
    expect(g[0]).toBe(filas.find((f) => f === g[0]));
  });

  it('un producto que no existe no inventa un grupo', () => {
    expect(idx.get('NO-EXISTE')).toBeUndefined();
  });

  it('lista vacía → índice vacío, sin reventar', () => {
    expect(agruparPorProducto([] as Fila[], comparar).size).toBe(0);
  });
});

describe('[RA-PERF.7] filtrarPorTipo — los traspasos, y la ausencia con una sola identidad', () => {
  const filas = universo(12);
  const idx = agruparPorProducto(filas, comparar);
  const tras = filtrarPorTipo(idx, 'traspaso');

  it('⭐ coincide con filtrar el barrido ingenuo, producto por producto', () => {
    for (const pid of idx.keys()) {
      const esperado = barridoIngenuo(filas, pid).filter((f) => f.type === 'traspaso');
      expect(tras.get(pid) ?? []).toEqual(esperado);
    }
  });

  it('un producto SIN traspasos no entra al mapa (para devolver siempre la misma referencia vacía)', () => {
    const soloCompra = [{ product_id: 'X', type: 'comprar', warehouse_code: 'PH', qty: 1 }];
    const sin = filtrarPorTipo(agruparPorProducto(soloCompra, comparar), 'traspaso');
    expect(sin.has('X')).toBe(false);
    expect(sin.size).toBe(0);
  });

  it('no se cuela ninguna fila de otro tipo', () => {
    for (const g of tras.values()) expect(g.every((f) => f.type === 'traspaso')).toBe(true);
  });

  it('el total de traspasos indexados es el total real (no se pierde ninguno)', () => {
    let n = 0;
    for (const g of tras.values()) n += g.length;
    expect(n).toBe(filas.filter((f) => f.type === 'traspaso').length);
  });
});
