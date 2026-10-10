import { agruparPorCodigo, resumirCambios, type PriceChangeRow } from './price-change-notice.contract';

/**
 * `[ETQ-AVISOS.1]` La regla que comparten la pantalla de «Cambios de precio» y el generador de
 * avisos. Si cambia acá, cambia en los dos lados; por eso se prueba una sola vez y a fondo.
 */
const fila = (sku: string, unidad: string, antes: number | null, ahora: number | null, hora: string | null = '10:00:00'): PriceChangeRow => ({
  sku, name: `PROD ${sku}`, unidad, precio_anterior: antes, precio_nuevo: ahora,
  delta: antes == null || ahora == null ? null : Math.round((ahora - antes) * 100) / 100,
  es_baja: ahora === 0, hora,
});

describe('agruparPorCodigo', () => {
  it('⭐ el caso real del 91059: tres renglones de la bitácora son un producto con dos presentaciones', () => {
    const r = agruparPorCodigo([
      fila('91059', 'CJA', 0, 6378.26, '08:00:00'),
      fila('91059', '500', 6523.34, 203.85, '10:00:00'),
      fila('91059', '500', 5602.87, 6523.34, '09:00:00'),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].filas.map((f) => f.unidad).sort()).toEqual(['500', 'CJA']);
    const u500 = r[0].filas.find((f) => f.unidad === '500')!;
    // lo que hay en el anaquel → lo que dice Kepler ahora, sin importar el orden en que llegó
    expect([u500.precio_anterior, u500.precio_nuevo, u500.delta]).toEqual([5602.87, 203.85, -5399.02]);
  });

  it('⛔ sin horas completas y distintas NO inventa el orden: deja las filas como llegan', () => {
    expect(agruparPorCodigo([fila('X', '500', 10, 20, null), fila('X', '500', 20, 5, null)])[0].filas).toHaveLength(2);
    expect(agruparPorCodigo([fila('Y', '500', 10, 20), fila('Y', '500', 20, 5)])[0].filas).toHaveLength(2);
  });

  it('un producto que terminó el día en su mismo precio queda sin filas y como «sin_cambio»', () => {
    const r = agruparPorCodigo([fila('Z', 'PAQ', 10, 12, '09:00:00'), fila('Z', 'PAQ', 12, 10, '10:00:00')]);
    expect(r[0].filas).toEqual([]);
    expect(r[0].direccion).toBe('sin_cambio');
  });

  it('manda la presentación que más cambió en proporción, aunque otra vaya al revés', () => {
    // la caja subió 1% y el paquete bajó 50%
    expect(agruparPorCodigo([fila('X', 'CJA', 1000, 1010), fila('X', 'PAQ', 10, 5)])[0].direccion).toBe('baja');
  });

  it('⛔ si el ERP le quitó el precio a UNA presentación, el producto es «sin precio» aunque otra suba', () => {
    const r = agruparPorCodigo([fila('X', 'PAQ', 10, 0), fila('X', 'CJA', 100, 120)]);
    expect(r[0].es_baja).toBe(true);
    expect(r[0].direccion).toBe('sin_precio');
  });

  it('ignora filas sin código y no revienta con la lista vacía', () => {
    expect(agruparPorCodigo([fila('', 'PAQ', 1, 2)])).toEqual([]);
    expect(agruparPorCodigo([])).toEqual([]);
  });
});

describe('resumirCambios', () => {
  const lista = [
    fila('1', 'PAQ', 10, 12, '09:00:00'), fila('1', 'CJA', 100, 120, '09:00:00'), // un producto, sube
    fila('2', 'PAQ', 10, 8),                                                       // baja
    fila('3', 'PAQ', 10, 0),                                                       // sin precio
    fila('4', 'PZA', 5, 6, '09:00:00'), fila('4', 'PZA', 6, 5, '10:00:00'),        // volvió
  ];

  it('⭐ suben + bajan + sin precio suman el total, y los que volvieron se cuentan aparte', () => {
    expect(resumirCambios(lista)).toEqual({ productos: 3, suben: 1, bajan: 1, sin_precio: 1, volvieron: 1 });
  });

  it('un día sin cambios da ceros, no revienta', () => {
    expect(resumirCambios([])).toEqual({ productos: 0, suben: 0, bajan: 0, sin_precio: 0, volvieron: 0 });
  });

  it('un día donde todo volvió a su precio NO tiene nada que avisar', () => {
    const r = resumirCambios([fila('4', 'PZA', 5, 6, '09:00:00'), fila('4', 'PZA', 6, 5, '10:00:00')]);
    expect(r.productos).toBe(0);
    expect(r.volvieron).toBe(1);
  });
});
