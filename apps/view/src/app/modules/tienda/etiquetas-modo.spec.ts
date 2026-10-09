import { describe, expect, it } from 'vitest';
import type { PresentacionPrecio } from '@megadulces/contracts';
import type { PriceChange } from './etiquetas.service';
import { agruparPorCodigo, esModoPrecio, unidadDeModo } from './etiquetas-modo';

const fila = (sku: string, unidad: string, antes: number | null, ahora: number | null, extra: Partial<PriceChange> = {}): PriceChange => ({
  sku, name: `PROD ${sku}`, unidad, precio_anterior: antes, precio_nuevo: ahora,
  delta: antes == null || ahora == null ? null : Math.round((ahora - antes) * 100) / 100,
  es_baja: ahora === 0, hora: '2026-10-08T10:00:00Z', ...extra,
});

const pres = (unidad: string, origen: PresentacionPrecio['origen'], precio: number | null, factor = 1): PresentacionPrecio => ({
  unidad, factor, origen, contenido: null, precio_lista: precio,
  mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_dato',
} as PresentacionPrecio);

describe('agruparPorCodigo · un código, una fila', () => {
  it('⭐ el caso real (91059 con tres presentaciones) sale como UN producto', () => {
    const r = agruparPorCodigo([
      fila('91059', 'CJA', 0, 6378.26),
      fila('91059', '500', 6523.34, 203.85),
      fila('91059', '500', 5602.87, 6523.34),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].sku).toBe('91059');
    expect(r[0].filas).toHaveLength(3);
  });

  it('conserva el orden en que aparece cada código y no mezcla productos', () => {
    const r = agruparPorCodigo([fila('B', 'PAQ', 10, 11), fila('A', 'PZA', 1, 2), fila('B', 'CJA', 100, 110)]);
    expect(r.map((p) => p.sku)).toEqual(['B', 'A']);
    expect(r[0].filas.map((f) => f.unidad)).toEqual(['PAQ', 'CJA']);
  });

  it('la dirección sale de la presentación que MÁS cambió en proporción, aunque otra vaya al revés', () => {
    // la caja subió 1% ($10 sobre $1,000) y el paquete bajó 50% ($5 sobre $10): manda el paquete
    const r = agruparPorCodigo([fila('X', 'CJA', 1000, 1010), fila('X', 'PAQ', 10, 5)]);
    expect(r[0].direccion).toBe('baja');
  });

  it('⛔ si el ERP le quitó el precio a UNA presentación, el producto es «sin precio» — aunque otra suba', () => {
    const r = agruparPorCodigo([fila('X', 'PAQ', 10, 0), fila('X', 'CJA', 100, 120)]);
    expect(r[0].es_baja).toBe(true);
    expect(r[0].direccion).toBe('sin_precio');
  });

  it('suben + bajan + sin precio suman el total de productos (el resumen tiene que cuadrar)', () => {
    const r = agruparPorCodigo([
      fila('1', 'PAQ', 10, 12), fila('1', 'CJA', 100, 120),
      fila('2', 'PAQ', 10, 8),
      fila('3', 'PAQ', 10, 0),
      fila('4', 'PZA', 5, 6),
    ]);
    const cuenta = (d: string) => r.filter((p) => p.direccion === d).length;
    expect(r).toHaveLength(4);
    expect(cuenta('sube') + cuenta('baja') + cuenta('sin_precio') + cuenta('sin_cambio')).toBe(4);
    expect([cuenta('sube'), cuenta('baja'), cuenta('sin_precio')]).toEqual([2, 1, 1]);
  });

  it('un precio nuevo (antes en $0) no revienta ni cuenta como «sin precio»', () => {
    const r = agruparPorCodigo([fila('N', 'CJA', 0, 6378.26)]);
    expect(r[0].direccion).toBe('sube');
    expect(r[0].es_baja).toBe(false);
  });

  it('ignora filas sin código en vez de armar un producto vacío', () => {
    expect(agruparPorCodigo([fila('', 'PAQ', 1, 2)])).toEqual([]);
    expect(agruparPorCodigo([])).toEqual([]);
  });
});

describe('unidadDeModo · qué presentación le toca a cada elección', () => {
  const ritz = [pres('PAQ', 'base', 42.15), pres('CJA', 'unidad2', 465.38, 12)];
  const suelto = [pres('PZA', 'base', 8.66), pres('PAQ', 'unidad2', 66.06, 8), pres('CJA', 'unidad3', 860.6, 112)];

  it('«todos» no elige ninguna: es el comportamiento de siempre', () => {
    expect(unidadDeModo(suelto, 'todos')).toBeNull();
  });

  it('pieza = la presentación BASE, no la que se llame PZA', () => {
    expect(unidadDeModo(suelto, 'pieza')).toBe('PZA');
    // con base PAQ, la «pieza» es el paquete: es lo que la etiqueta ya imprime como precio base
    expect(unidadDeModo(ritz, 'pieza')).toBe('PAQ');
  });

  it('paquete y caja buscan su rótulo', () => {
    expect(unidadDeModo(suelto, 'paquete')).toBe('PAQ');
    expect(unidadDeModo(suelto, 'caja')).toBe('CJA');
  });

  it('⛔ un producto SIN esa presentación devuelve null — no se inventa otra', () => {
    expect(unidadDeModo([pres('PZA', 'base', 8.66)], 'caja')).toBeNull();
    expect(unidadDeModo([pres('PZA', 'base', 8.66)], 'paquete')).toBeNull();
  });

  it('una presentación sin precio publicado no cuenta', () => {
    expect(unidadDeModo([pres('PZA', 'base', 8.66), pres('CJA', 'unidad2', null, 12)], 'caja')).toBeNull();
    expect(unidadDeModo(undefined, 'pieza')).toBeNull();
  });
});

describe('esModoPrecio · el estado del historial lo puede escribir cualquiera', () => {
  it('sólo acepta los cuatro modos', () => {
    for (const m of ['todos', 'pieza', 'paquete', 'caja']) expect(esModoPrecio(m)).toBe(true);
    for (const m of ['', 'CAJA', 'granel', null, undefined, 3, {}]) expect(esModoPrecio(m)).toBe(false);
  });
});
