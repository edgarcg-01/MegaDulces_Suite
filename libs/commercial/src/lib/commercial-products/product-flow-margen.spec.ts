import {
  MargenFila,
  fuentesDeMargen,
  margenRealDe,
  noSeVende,
  tramoSinVenta,
} from './product-flow';
import { escaleraDeFicha, margenesDe } from './new-products';

const NOMBRES = new Map([['01', 'Padre Hidalgo'], ['06', 'Canindo']]);
const ESC = escaleraDeFicha({ u1: 'PZA', u2: null, u3: 'CJA', f2: null, f3: '12', uxc: '12' });

describe('[PF.4] los que no se venden', () => {
  it('el tramo: 30 a 89 días, 90 o más, y sin venta en el año que se mira', () => {
    expect(tramoSinVenta(30)).toBe('mes');
    expect(tramoSinVenta(89)).toBe('mes');
    expect(tramoSinVenta(90)).toBe('trimestre');
    expect(tramoSinVenta(null)).toBe('anio');
  });

  const fila = {
    product_id: 'p', sku: '90037', nombre: 'BOTA TUTSI', existencia: '1971', valor: '40011.3', sin_costo: true,
    plazas: ['01', '06'], ultima: '2026-06-01', dias: '130',
  };

  it('con permiso de costo trae el dinero detenido y avisa si alguna sucursal no tiene costo en la ficha', () => {
    const x = noSeVende(fila, NOMBRES, ESC, true);
    expect(x).toMatchObject({ existencia: 1971, valor: 40011.3, valor_incompleto: true, tramo: 'trimestre', dias_sin_venta: 130 });
    expect(x.plazas).toEqual([{ plaza: '01', nombre: 'Padre Hidalgo' }, { plaza: '06', nombre: 'Canindo' }]);
  });

  it('[negativa] sin permiso de costo no hay dinero (ni la marca de que falta costo)', () => {
    expect(noSeVende(fila, NOMBRES, ESC, false)).toMatchObject({ valor: null, valor_incompleto: false });
  });
});

describe('[PF.5] márgenes: las fuentes de Productos nuevos, armadas desde la función', () => {
  // Padre Hidalgo vende 100 netos en pieza (factor 1) y 200 en caja (factor 12); la ficha pone 20% a la pieza
  // y 10% a la caja. De la caja, sólo 120 traen costo (96). Compró 240 piezas por 1,500 sin impuesto.
  const filas: MargenFila[] = [
    { tipo: 'venta', plaza: '01', factor: '1.0000', unidad_base: 'PZA', n: '100', nc: '100', c: '70', q: '20' },
    { tipo: 'venta', plaza: '01', factor: '12.0000', unidad_base: 'PZA', n: '200', nc: '120', c: '96', q: '48' },
    { tipo: 'venta', plaza: '06', factor: '1.0000', unidad_base: 'PZA', n: '50', nc: null, c: null, q: '10' },
    { tipo: 'entrada', plaza: '01', factor: '12.0000', unidad_base: 'PZA', n: '1500', nc: null, c: null, q: '240' },
  ];
  const meta = [{ plaza: '01', factor: '1.0000', margen: '20' }, { plaza: '01', factor: '12', margen: '10' }];

  it('por sucursal: venta neta, la que trae costo, su costo, la meta por peldaño VENDIDO y lo vendido por unidad base', () => {
    const { porPlaza, compra } = fuentesDeMargen(filas, meta);
    expect(porPlaza.get('01')).toEqual({ n: 300, nc: 220, c: 166, nm: 300, m: 40, b: { PZA: { q: 68, n: 300 } } });
    // Canindo no tiene meta en la ficha: su venta no entra al margen de lista (no se dibuja como cero).
    expect(porPlaza.get('06')).toMatchObject({ n: 50, nc: 0, nm: 0, m: 0 });
    expect(compra).toEqual({ PZA: { q: 240, i: 1500 } });
  });

  it('⭐ los tres márgenes salen con la MISMA función que Productos nuevos', () => {
    const { porPlaza, compra } = fuentesDeMargen(filas, meta);
    const m = margenesDe([porPlaza.get('01')!], compra)!;
    expect(m.lista).toMatchObject({ pct: 13.3, cobertura: 1 });
    // (220 − 166) / 220 = 24.5%, sobre el 73% de la venta que trae costo.
    expect(m.real).toMatchObject({ pct: 24.5, cobertura: 0.733 });
    // Lo pagado: 1,500 / 240 = 6.25 por pieza; 68 piezas = 425 contra 300 netos.
    expect(m.pagado.pct).toBe(-41.7);
    expect(m.costo_pagado).toEqual({ unidad: 'PZA', por_unidad: 6.25 });
  });

  it('el margen real de la lista = el real de margenesDe, con su cobertura', () => {
    expect(margenRealDe('300', '220', '166')).toMatchObject({ pct: 24.5, cobertura: 0.733 });
    expect(margenRealDe('50', '0', '0')).toMatchObject({ pct: null, cobertura: 0 });
    expect(margenRealDe('0', '0', '0')).toBeNull();
  });
});

describe('[PF.4] la consulta sin la matvista de Productos nuevos', () => {
  it('⛔ la variante quita la exclusión de nuevos y conserva los mismos 4 parámetros (si no, knex truena)', async () => {
    const { NO_SE_VENDEN_SQL, NO_SE_VENDEN_SIN_NUEVOS_SQL } = await import('./product-flow.sql');
    const params = (q: string) => (q.match(/\?/g) ?? []).length;
    expect(NO_SE_VENDEN_SIN_NUEVOS_SQL).not.toBe(NO_SE_VENDEN_SQL);
    expect(NO_SE_VENDEN_SIN_NUEVOS_SQL).not.toContain('mv_new_products');
    expect(NO_SE_VENDEN_SQL).toContain('mv_new_products');
    expect(params(NO_SE_VENDEN_SIN_NUEVOS_SQL)).toBe(params(NO_SE_VENDEN_SQL));
  });
});
