import { describe, expect, it } from 'vitest';
import { armarSenales, FilaCostoEstandar, FilaPerdidaWincaja } from './pedido-senales';

// Valores tomados de prod el 2026-10-02 (analytics.v_kepler_standard_cost / replenishment_plan /
// v_sku_lost_demand). Precio de ficha CON impuesto; costos por unidad base.
const fila = (sucursal: string, o: Partial<FilaCostoEstandar> = {}): FilaCostoEstandar => ({
  sucursal, sku: '95434', margen_real_pct: -22.93, vende_bajo_costo: true, precio_ficha: 51.12, impuesto_pct: 8,
  costo_reposicion_base: 61.42, venta_neta_30d: 22177.74, es_plaza_operativa: true, ...o,
});
const NIKOLO = { product_id: 'p-nikolo', sku: '95434', uxc: 16, pack_size: null, caja_cost: 646.29 };
const base = { rows: [NIKOLO], mRows: [fila('01'), fila('08', { margen_real_pct: -18.88, costo_reposicion_base: 58.35, venta_neta_30d: 15204.76 })],
  pRows: [{ product_id: 'p-nikolo', real_buy_cost: 60.907, last_purchase: '2026-09-05' }], lRows: [], fRows: [], desde: '2026-07-01' };

describe('[RA-PRO.67] margen — tres costos, tres preguntas', () => {
  const m = armarSenales(base).get('p-nikolo')?.margin;

  it('margen de hoy = el de Costo estándar, ponderado por venta de 30 d', () => {
    // (−22.93 × 22177.74 + −18.88 × 15204.76) / 37382.5
    expect(m?.margen_pct).toBeCloseTo(-21.28, 1);
    expect(m?.sucursales_bajo_costo).toBe(2);
  });
  it('esta compra usa la LISTA del proveedor (646.29 / 16 = 40.39): NIKOLO deja +17 %', () => {
    expect(m?.margen_compra_pct).toBeCloseTo(17.18, 1);
  });
  it('con lo pagado (60.91) vuelve a perder: el testigo de la lista', () => {
    expect(m?.margen_pagado_pct).toBeCloseTo(-22.29, 1);
    expect(m?.ultima_compra).toBe('2026-09-05');
  });
  it('⭐ NEGATIVA: la plaza 00 (oficinas) NO entra al margen', () => {
    const s = armarSenales({ ...base, mRows: [...base.mRows, fila('00', { margen_real_pct: 90, vende_bajo_costo: false, venta_neta_30d: 999999, es_plaza_operativa: false })] });
    expect(s.get('p-nikolo')?.margin?.margen_pct).toBeCloseTo(-21.28, 1);
    expect(s.get('p-nikolo')?.margin?.por_sucursal['00']).toBeUndefined();
  });
  it('⭐ NEGATIVA: costo de caja que no cuadra con la unidad (>2× la reposición) → null, no un margen imposible', () => {
    // 70006: caja 787.04 con factor 1, reposición 43.72/kg → razón 18×
    const s = armarSenales({ ...base, rows: [{ ...NIKOLO, caja_cost: 787.04, uxc: 1 }], pRows: [] });
    expect(s.get('p-nikolo')?.margin?.margen_compra_pct).toBeNull();
  });
  it('sin impuesto medido no hay precio neto: margen de compra null', () => {
    const s = armarSenales({ ...base, mRows: [fila('01', { impuesto_pct: null })] });
    expect(s.get('p-nikolo')?.margin?.margen_compra_pct).toBeNull();
  });
  it('placebo: costo sin cambio → los tres márgenes coinciden (83185)', () => {
    const s = armarSenales({
      rows: [{ product_id: 'p', sku: '83185', uxc: 10, caja_cost: 372.53 }],
      mRows: [{ sucursal: '01', sku: '83185', margen_real_pct: 22.99, vende_bajo_costo: false, precio_ficha: 49.48, impuesto_pct: 8, costo_reposicion_base: 37.25, venta_neta_30d: 19863, es_plaza_operativa: true }],
      pRows: [{ product_id: 'p', real_buy_cost: 37.2526, last_purchase: '2026-09-28' }], lRows: [], fRows: [], desde: '2026-07-01',
    }).get('p')?.margin;
    expect(s?.margen_pct).toBeCloseTo(22.99, 1);
    expect(s?.margen_compra_pct).toBeCloseTo(22.99, 1);
    expect(s?.margen_pagado_pct).toBeCloseTo(22.99, 1);
  });
});

describe('[RA-PRO.67] venta perdida — sólo se suma lo que cuadra con el precio', () => {
  const W = (sucursal: string, importe: number, unidades: number, reportes = 1, ultimo = '2026-09-10'): FilaPerdidaWincaja =>
    ({ sucursal, sku: '95434', importe, unidades, reportes, ultimo });

  it('un renglón a precio de ficha se suma', () => {
    const l = armarSenales({ ...base, lRows: [W('08', 3725.27, 80)] }).get('p-nikolo')?.lost;
    expect(l?.wincaja.importe).toBeCloseTo(3725.27, 2);
    expect(l?.wincaja.reportes_sin_verificar).toBe(0);
    expect(l?.wincaja.por_sucursal['08']?.importe).toBeCloseTo(3725.27, 2);
  });
  it('⭐ NEGATIVA: CEDIS a 39× el precio (99686) NO se suma, se cuenta como sin verificar', () => {
    const l = armarSenales({ ...base, mRows: [...base.mRows, fila('00', { es_plaza_operativa: false })], lRows: [W('00', 51.12 * 39.5 * 60, 60)] }).get('p-nikolo')?.lost;
    expect(l?.wincaja.importe).toBe(0);
    expect(l?.wincaja.reportes_sin_verificar).toBe(1);
    expect(l?.wincaja.ultimo_dato).toBe('2026-09-10');   // la fecha sí se publica: la fuente habló
  });
  it('multipack: cuadra contra el PAQUETE aunque la ficha esté en pieza (KINDER, razón 6.6 con paquete de 10)', () => {
    const s = armarSenales({
      rows: [{ product_id: 'k', sku: '42029', uxc: 140, pack_size: 10, caja_cost: 1500 }],
      mRows: [{ sucursal: '08', sku: '42029', margen_real_pct: 53, vende_bajo_costo: false, precio_ficha: 17.01, impuesto_pct: 8, costo_reposicion_base: 10, venta_neta_30d: 1, es_plaza_operativa: true }],
      pRows: [], fRows: [], desde: '2026-07-01',
      lRows: [{ sucursal: '08', sku: '42029', importe: 7876.85, unidades: 70, reportes: 1, ultimo: '2026-09-07' }],
    }).get('k')?.lost;
    expect(s?.wincaja.importe).toBeCloseTo(7876.85, 2);
  });
  it('⭐ NEGATIVA: sin ficha contra qué medir → sin verificar', () => {
    const l = armarSenales({ ...base, lRows: [W('05', 500, 10)] }).get('p-nikolo')?.lost;
    expect(l?.wincaja.importe).toBe(0);
    expect(l?.wincaja.reportes_sin_verificar).toBe(1);
  });
  it('mostrador: se reporta aparte, con su importe estimado', () => {
    const l = armarSenales({ ...base, fRows: [{ product_id: 'p-nikolo', code: '05', reportes: 2, importe: 33.9, ultimo: '2026-09-23' }] }).get('p-nikolo')?.lost;
    expect(l?.mostrador.reportes).toBe(2);
    expect(l?.mostrador.importe_estimado).toBeCloseTo(33.9, 2);
    expect(l?.wincaja.reportes).toBe(0);
  });
  it('sin ningún reporte no hay bloque de venta perdida (null, no ceros)', () => {
    expect(armarSenales(base).get('p-nikolo')?.lost).toBeNull();
  });
});
