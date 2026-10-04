import { describe, expect, it } from 'vitest';
import { CeldaSucursal, clasificarEntreSucursales } from './entre-sucursales';

const c = (sucursal: string, costo: number, unidad: string | null = 'PZA', vende = true): CeldaSucursal => ({
  sucursal,
  costo,
  unidad,
  vende,
});

describe('[CAT-COSTO.4] clasificarEntreSucursales', () => {
  it('todas las plazas con el mismo costo → igual, sin sucursales fuera', () => {
    const r = clasificarEntreSucursales([c('01', 54.1), c('02', 54.1), c('03', 54.1)]);
    expect(r.veredicto).toBe('igual');
    expect(r.mayoria).toBe(54.1);
    expect(r.sucursales_fuera).toEqual([]);
    expect(r.diferencia_pct).toBe(0);
  });

  it('una plaza que se sale de la mayoría → distinto, y dice cuál y cuánto', () => {
    const r = clasificarEntreSucursales([c('01', 71.84), c('02', 71.84), c('03', 69.9), c('04', 71.84)]);
    expect(r.veredicto).toBe('distinto');
    expect(r.mayoria).toBe(71.84);
    expect(r.sucursales_fuera).toEqual(['03']);
    expect(r.celdas.find((x) => x.sucursal === '03')?.desviacion_pct).toBe(-2.7);
    expect(r.diferencia_pct).toBe(2.7);
  });

  it('el borde de la tolerancia de 0.5 %: 0.4 % es igual, 0.6 % es distinto', () => {
    expect(clasificarEntreSucursales([c('01', 100), c('02', 100), c('03', 100.4)]).veredicto).toBe('igual');
    expect(clasificarEntreSucursales([c('01', 100), c('02', 100), c('03', 100.6)]).veredicto).toBe('distinto');
  });

  it('[negativa] dos valores empatados NO eligen uno: sin_mayoria y la brecha entre extremos', () => {
    const r = clasificarEntreSucursales([c('01', 27.4), c('02', 29.1)]);
    expect(r.veredicto).toBe('sin_mayoria');
    expect(r.mayoria).toBeNull();
    expect(r.sucursales_fuera).toEqual([]);
    expect(r.diferencia_pct).toBe(6.2);
    expect(r.celdas.every((x) => x.fuera === null)).toBe(true);
  });

  it('[negativa] unidad base distinta entre plazas NO se compara (daría ×20 falso)', () => {
    const r = clasificarEntreSucursales([c('01', 89.2, 'KG'), c('02', 89.2, 'KG'), c('03', 1784, 'CJA')]);
    expect(r.veredicto).toBe('unidad_distinta');
    expect(r.mayoria).toBeNull();
    expect(r.diferencia_pct).toBeNull();
  });

  it('una ficha sin rótulo de unidad cuenta como unidad distinta', () => {
    expect(clasificarEntreSucursales([c('01', 10), c('02', 10, null)]).veredicto).toBe('unidad_distinta');
  });

  it('el rótulo se compara sin mayúsculas ni espacios', () => {
    expect(clasificarEntreSucursales([c('01', 10, 'pza '), c('02', 10, 'PZA')]).veredicto).toBe('igual');
  });

  it('una sola plaza con costo → una_plaza; los costos en cero o inválidos no cuentan', () => {
    expect(clasificarEntreSucursales([c('01', 10)]).veredicto).toBe('una_plaza');
    expect(clasificarEntreSucursales([c('01', 10), c('02', 0), c('03', Number.NaN)]).veredicto).toBe('una_plaza');
  });

  it('solo con venta: la plaza que no vende no se compara, pero sigue en la respuesta', () => {
    const celdas = [c('01', 38), c('02', 38), c('03', 38), c('04', 42.7, 'PZA', false)];
    const todas = clasificarEntreSucursales(celdas);
    expect(todas.veredicto).toBe('distinto');
    expect(todas.sucursales_fuera).toEqual(['04']);

    const conVenta = clasificarEntreSucursales(celdas, { soloConVenta: true });
    expect(conVenta.veredicto).toBe('igual');
    const p04 = conVenta.celdas.find((x) => x.sucursal === '04');
    expect(p04?.comparada).toBe(false);
    expect(p04?.fuera).toBeNull();
  });
});
