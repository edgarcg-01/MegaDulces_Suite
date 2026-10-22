import { totalesCotizacion } from './quote-totals';

/**
 * `[E.19]` La cuenta de la cotización: lo que el papel le dice al cliente tiene que ser lo que la
 * base guardó, y la columna de netos tiene que sumar el total que se imprime abajo.
 *
 * Los valores de referencia son de PRODUCCIÓN, no inventados: COT-2026-00021 (21-oct-2026),
 * 3 % de descuento de cliente. Medido ese día: la cabecera de las 22 cotizaciones con renglones
 * cumple `total = round(Σ renglones × (1 − %))` sin una sola excepción.
 */
describe('totalesCotizacion', () => {
  it('reproduce al centavo lo que el servidor guardó (COT-2026-00021, 3 %)', () => {
    const t = totalesCotizacion([242286.81], 3);
    expect(t.importe).toBe(242286.81);
    expect(t.total).toBe(235018.21);
    expect(t.subtotal).toBe(202601.91);
    expect(t.iva).toBe(32416.3);
    expect(t.descuento).toBe(7268.6);
    // sin tasas registradas (cotización anterior a E.25) el IVA es ASUMIDO, y se cuenta
    expect(t.impuesto_asumido).toBe(1);
  });

  /**
   * `[E.25]` Un pedido REAL de Kepler (telemarketing UD40 01-0003309, cliente C1068 con 2 %): cinco
   * renglones de IEPS 8 % y tres de IVA 16 %. Kepler guardó c16 = 5,016.07 · c14 IVA = 180.03 ·
   * c15 IEPS = 274.88 (`kepler_ods.kdm1`, leído el 2026-10-21).
   */
  const PEDIDO_3309 = {
    importes: [706.2, 789.5, 893.76, 697.5, 699.6, 641.8, 523.28, 166.8],
    tasas: [
      ...Array.from({ length: 5 }, () => ({ iva: 0, ieps: 0.08 })),
      ...Array.from({ length: 3 }, () => ({ iva: 0.16, ieps: 0 })),
    ],
  };

  it('con la tasa de cada producto reproduce el IVA y el IEPS que guardó Kepler (01-0003309)', () => {
    const t = totalesCotizacion(PEDIDO_3309.importes, 2, PEDIDO_3309.tasas);
    expect(t.total).toBe(5016.07);
    expect(t.iva).toBe(180.03);
    expect(t.ieps).toBe(274.88);
    expect(t.subtotal).toBe(4561.16);
    expect(t.impuesto_asumido).toBe(0);
  });

  it('NEGATIVO: sin las tasas, el mismo pedido NO cuadra con Kepler y lo declara', () => {
    const t = totalesCotizacion(PEDIDO_3309.importes, 2);
    expect(t.total).toBe(5016.07);
    expect(t.iva).not.toBe(180.03);
    expect(t.ieps).toBe(0);
    expect(t.impuesto_asumido).toBe(8);
  });

  it('con los dos impuestos va en cascada (IEPS sobre la base, IVA sobre base + IEPS) y cierra', () => {
    const t = totalesCotizacion([124], null, [{ iva: 0.16, ieps: 0.08 }]);
    expect(t.ieps).toBe(7.92);
    expect(t.iva).toBe(17.1);
    expect(Math.round((t.subtotal + t.iva + t.ieps) * 100)).toBe(12400);
  });

  it('sin descuento, el total es la suma y los netos son los importes', () => {
    const t = totalesCotizacion([100, 250.5, 49.5], null);
    expect(t.total).toBe(400);
    expect(t.descuento).toBe(0);
    expect(t.descuento_pct).toBeNull();
    expect(t.netos).toEqual([100, 250.5, 49.5]);
  });

  it('la columna de netos suma EXACTO el total, aunque el reparto deje centavos sueltos', () => {
    const importes = [33.33, 33.33, 33.34, 0.01, 1234.57, 19.99];
    const t = totalesCotizacion(importes, 2.5);
    const suma = t.netos.reduce<number>((a, n) => a + (n ?? 0), 0);
    expect(Math.round(suma * 100)).toBe(Math.round(t.total * 100));
    // y ningún renglón se aleja más de un centavo de su parte proporcional
    importes.forEach((imp, i) => {
      expect(Math.abs((t.netos[i] as number) - imp * 0.975)).toBeLessThanOrEqual(0.01 + 1e-9);
    });
  });

  it('un renglón sin precio no entra a la cuenta, se cuenta aparte y su neto es null (no $0)', () => {
    const t = totalesCotizacion([100, null, 200], 3);
    expect(t.importe).toBe(300);
    expect(t.total).toBe(291);
    expect(t.sin_precio).toBe(1);
    expect(t.netos[1]).toBeNull();
    expect((t.netos[0] as number) + (t.netos[2] as number)).toBe(291);
  });

  it('un regalo (importe 0) queda en 0 y no recibe centavos del reparto', () => {
    const t = totalesCotizacion([10.01, 0, 10.01, 10.01], 3);
    expect(t.netos[1]).toBe(0);
    expect(Math.round(t.netos.reduce<number>((a, n) => a + (n ?? 0), 0) * 100)).toBe(Math.round(t.total * 100));
  });

  it('un % inválido o negativo se trata como sin descuento, nunca como recargo', () => {
    expect(totalesCotizacion([100], -5).total).toBe(100);
    expect(totalesCotizacion([100], Number.NaN).total).toBe(100);
  });
});
