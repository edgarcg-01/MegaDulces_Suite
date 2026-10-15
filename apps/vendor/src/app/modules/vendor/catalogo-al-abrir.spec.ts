import {
  CATALOGO_FRESCO_MS,
  CATALOGO_MAX_EDAD_MS,
  edadCatalogo,
  hayQueRefrescar,
  sirveCopia,
} from './catalogo-al-abrir';

const AHORA = Date.parse('2026-10-15T17:00:00Z');

describe('[VTK.11] abrir con el catálogo guardado', () => {
  it('⭐ sirve la copia de la MISMA sucursal y no la de otra (la existencia es por almacén)', () => {
    const copia = { warehouseId: 'piedad', at: AHORA - 10 * 60_000 };
    expect(sirveCopia(copia, 'piedad', AHORA)).toBe(true);
    // Prueba negativa: la copia de la camioneta no se usa para abrir con la sucursal.
    expect(sirveCopia(copia, 'camioneta', AHORA)).toBe(false);
  });

  it('⭐ una copia de más de un día no se muestra: se espera la descarga', () => {
    expect(sirveCopia({ warehouseId: 'w', at: AHORA - CATALOGO_MAX_EDAD_MS + 1 }, 'w', AHORA)).toBe(true);
    expect(sirveCopia({ warehouseId: 'w', at: AHORA - CATALOGO_MAX_EDAD_MS }, 'w', AHORA)).toBe(false);
  });

  it('sin copia, o con fecha rota o del futuro, no sirve', () => {
    expect(sirveCopia(null, 'w', AHORA)).toBe(false);
    expect(sirveCopia({ warehouseId: 'w', at: Number.NaN }, 'w', AHORA)).toBe(false);
    expect(sirveCopia({ warehouseId: 'w', at: AHORA + 60_000 }, 'w', AHORA)).toBe(false);
  });

  it('sin sucursal asignada, sólo sirve la copia guardada también sin sucursal', () => {
    expect(sirveCopia({ warehouseId: '', at: AHORA - 1000 }, '', AHORA)).toBe(true);
    expect(sirveCopia({ warehouseId: 'w', at: AHORA - 1000 }, '', AHORA)).toBe(false);
  });

  it('⭐ se refresca detrás sólo si lo mostrado es copia y ya no es fresca', () => {
    expect(hayQueRefrescar('memoria', AHORA - 30_000, AHORA)).toBe(false);
    expect(hayQueRefrescar('memoria', AHORA - CATALOGO_FRESCO_MS, AHORA)).toBe(true);
    expect(hayQueRefrescar('telefono', AHORA - 3 * 60 * 60_000, AHORA)).toBe(true);
    // Recién bajado del servidor: no se vuelve a pedir.
    expect(hayQueRefrescar('servidor', AHORA - 3 * 60 * 60_000, AHORA)).toBe(false);
  });

  it('la edad se dice en palabras', () => {
    expect(edadCatalogo(20_000)).toBe('hace un momento');
    expect(edadCatalogo(4 * 60_000 + 59_000)).toBe('hace 4 min');
    expect(edadCatalogo(3 * 60 * 60_000 + 10)).toBe('hace 3 h');
    expect(edadCatalogo(-5)).toBe('hace un momento');
  });
});
