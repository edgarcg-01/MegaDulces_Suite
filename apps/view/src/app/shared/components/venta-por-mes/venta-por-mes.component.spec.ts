import { describe, expect, it } from 'vitest';
import type { MonthlySalesResponse } from '@megadulces/contracts';
import { barrasVentaPorMes } from './venta-por-mes.component';

const R = (months: MonthlySalesResponse['months']): MonthlySalesResponse =>
  ({ product: { sku: '97245', nombre: 'MR BEAST' }, warehouse: '01', bf: 10, months, window: null });

describe('[AB.41] barrasVentaPorMes — 13 meses contra el año anterior', () => {
  const HOY = new Date(2026, 9, 26);   // 26-oct-2026

  it('13 barras, de oct-25 a oct-26, la última es el mes en curso; enero lleva el año', () => {
    const b = barrasVentaPorMes(R([]), HOY);
    expect(b).toHaveLength(13);
    expect(b[0].mes).toBe('2025-10');
    expect(b[12]).toMatchObject({ mes: '2026-10', actual: true });
    expect(b.find((x) => x.mes === '2026-01')!.label).toBe('ene 26');
  });

  it('cada mes trae su mismo mes del año anterior', () => {
    const b = barrasVentaPorMes(R([
      { mes: '2026-09', venta: 1200, cajas: 30, cajas_parcial: false },
      { mes: '2025-09', venta: 800, cajas: 20, cajas_parcial: false },
    ]), HOY);
    expect(b.find((x) => x.mes === '2026-09')).toMatchObject({ venta: 1200, cajas: 30, ly: 800, lyCajas: 20 });
  });

  it('⛔ un mes con cajas sin medir sale null (no 0), y el parcial se marca', () => {
    const b = barrasVentaPorMes(R([
      { mes: '2026-08', venta: 500, cajas: null, cajas_parcial: false },
      { mes: '2026-07', venta: 400, cajas: 12, cajas_parcial: true },
    ]), HOY);
    expect(b.find((x) => x.mes === '2026-08')!.cajas).toBeNull();
    expect(b.find((x) => x.mes === '2026-07')!.parcial).toBe(true);
    expect(b.find((x) => x.mes === '2025-11')!.lyCajas).toBeNull();    // sin dato el año anterior: no se inventa
  });

  it('sin respuesta no hay barras', () => {
    expect(barrasVentaPorMes(null, HOY)).toEqual([]);
  });
});
