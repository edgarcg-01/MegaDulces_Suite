// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { CeldaCruda, filaMatriz } from './matriz-costos';

const c = (sucursal: string, costo: number, over: Partial<CeldaCruda> = {}): CeldaCruda => ({
  sucursal,
  costo,
  desde: '2026-10-01',
  fuente: 'ficha',
  referencia: null,
  unidad: 'PAQ',
  vende: true,
  ...over,
});

describe('[CAT-COSTO.10] filaMatriz', () => {
  it('la hoja de Compras: 78.66 en los nueve almacenes → iguales, coincidencia 100 %', () => {
    const r = filaMatriz(['00', '01', '02', '03', '04', '05', '06', '07', '08'].map((s) => c(s, 78.66)));
    expect(r.veredicto).toBe('igual');
    expect(r.mayoria).toBe(78.66);
    expect(r.coincidencia_pct).toBe(100);
  });

  it('un almacén que se sale → distinto; la coincidencia cuenta cuántos tienen el de la mayoría', () => {
    const r = filaMatriz([c('00', 66.52), c('01', 69.98), c('02', 66.52), c('03', 66.52)]);
    expect(r.veredicto).toBe('distinto');
    expect(r.coincidencia_pct).toBe(75);
    expect(r.celdas.find((x) => x.sucursal === '01')?.fuera).toBe(true);
    expect(r.celdas.find((x) => x.sucursal === '02')?.fuera).toBe(false);
  });

  it('NEGATIVA: sin mayoría NO inventa una coincidencia', () => {
    const r = filaMatriz([c('01', 10), c('02', 12)]);
    expect(r.veredicto).toBe('sin_mayoria');
    expect(r.coincidencia_pct).toBeNull();
  });

  it('NEGATIVA: con unidades distintas no se compara (daría ×20 falso)', () => {
    const r = filaMatriz([c('01', 66.52, { unidad: 'PAQ' }), c('02', 1330.46, { unidad: 'CJA' }), c('03', 66.52)]);
    expect(r.veredicto).toBe('unidad_distinta');
    expect(r.coincidencia_pct).toBeNull();
  });

  it('un solo almacén con costo → una_plaza, sin coincidencia', () => {
    const r = filaMatriz([c('01', 10)]);
    expect(r.veredicto).toBe('una_plaza');
    expect(r.coincidencia_pct).toBeNull();
  });

  it('la celda conserva de dónde salió el costo (deducido de la venta, o el folio de la compra)', () => {
    const r = filaMatriz([c('01', 10, { fuente: 'venta' }), c('02', 10, { fuente: 'xa2001', referencia: 'XA2001-0000687' })]);
    expect(r.celdas[0].fuente).toBe('venta');
    expect(r.celdas[1].referencia).toBe('XA2001-0000687');
  });

  it('comparar sólo almacenes con venta deja fuera de la coincidencia a los que no vendieron', () => {
    const r = filaMatriz([c('01', 10), c('02', 10), c('03', 99, { vende: false })], { soloConVenta: true });
    expect(r.veredicto).toBe('igual');
    expect(r.coincidencia_pct).toBe(100);
  });
});
