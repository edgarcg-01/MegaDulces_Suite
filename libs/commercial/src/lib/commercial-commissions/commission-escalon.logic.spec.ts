import { decidirEscalon, elegirEscalon } from './commission-escalon.logic';

/**
 * `[RD.103.2]` El árbitro es el libro de Comercial «COMISIONES RV MORELIA 2026», hoja
 * COMISIONES VECINAL, con sus propias cifras (costo, subtotal, venta por catorcena) y lo que sus
 * fórmulas pagaron. Si la regla del motor no da esto al centavo, no es la regla que se usa hoy.
 */
const VECINAL = { gate_field: 'markup', base_field: 'subtotal', piso_chofer_venta: 129999.99 };
const ESCALONES_VECINAL = [
  { min_amount: -100, max_amount: 12.01, pct: 2.73 },
  { min_amount: 12.01, max_amount: 13.01, pct: 2.95 },
  { min_amount: 13.01, max_amount: 15.01, pct: 3.13 },
  { min_amount: 15.01, max_amount: 18.01, pct: 3.41 },
  { min_amount: 18.01, max_amount: null, pct: 4.0 },
];
const SUPERVISOR = 0.2;
const markup = (sub: number, costo: number) => (sub / costo - 1) * 100;
const r2 = (n: number) => Math.round(n * 100) / 100;

function pagar(sub: number, costo: number, venta: number) {
  const d = decidirEscalon(VECINAL, ESCALONES_VECINAL, { venta, subtotal: sub }, markup(sub, costo));
  if (!d.paga) return d;
  const total = d.base * (d.pct / 100);
  return { ...d, total: r2(total), supervisor: r2(total * SUPERVISOR), chofer: r2(total * (1 - SUPERVISOR)) };
}

describe('[RD.103.2] el escalón vecinal reproduce el libro', () => {
  it('catorcena 1: markup 13.67 % → 3.13 %; chofer $5,756.56 y supervisor $1,439.14 (libro J3 / I3)', () => {
    const p = pagar(229894.48, 202252.53, 252061.17) as any;
    expect(p.pct).toBe(3.13);
    expect(p.chofer).toBe(5756.56);
    expect(p.supervisor).toBe(1439.14);
    expect(p.chofer_bajo_piso).toBe(false);
  });

  it('catorcena 18: markup 18.85 % → 4.00 % (libro G20)', () => {
    const p = pagar(269903.271, 227095.4687, 273152.66) as any;
    expect(p.pct).toBe(4);
    expect(p.chofer).toBe(8636.9);
  });

  it('catorcena 21: venta $95,077 bajo el piso → el chofer NO cobra, el supervisor sí ($648.43, libro I23)', () => {
    const p = pagar(95077.46, 82550.85, 95077.46) as any;
    expect(p.pct).toBe(3.41);
    expect(p.chofer_bajo_piso).toBe(true);
    expect(p.supervisor).toBe(648.43);
  });

  it('el piso es estricto: venta = $129,999.99 no pasa (el libro usa >)', () => {
    const d = decidirEscalon(VECINAL, ESCALONES_VECINAL, { venta: 129999.99, subtotal: 120000 }, 16) as any;
    expect(d.chofer_bajo_piso).toBe(true);
  });

  it('sin costo no hay markup: se declara sin_costo, no cae al primer escalón', () => {
    expect(decidirEscalon(VECINAL, ESCALONES_VECINAL, { venta: 300000, subtotal: 280000 }, null))
      .toEqual({ paga: false, motivo: 'sin_costo' });
  });

  it('control negativo: con el escalón por VENTA la misma catorcena 1 caería en otro tramo', () => {
    // Si el motor ignorara gate_field y escalonara por pesos, 229,894 no está en ningún tramo de
    // markup (el último empieza en 18.01) salvo el abierto: pagaría 4 % en vez de 3.13 %.
    const d = decidirEscalon({ ...VECINAL, gate_field: 'venta' }, ESCALONES_VECINAL,
      { venta: 252061.17, subtotal: 229894.48 }, 13.67) as any;
    expect(d.pct).toBe(4);
    expect(d.pct).not.toBe(3.13);
  });
});

describe('[RD.103.2] Ruta Directa no cambia', () => {
  const RD = { gate_field: 'venta', base_field: 'subtotal', piso_chofer_venta: null };
  const ESCALONES_RD = [
    { min_amount: 189999.99, max_amount: 250000, pct: 3.75 },
    { min_amount: 250000, max_amount: null, pct: 5 },
  ];

  it('bajo el primer escalón: bajo_umbral, como siempre', () => {
    expect(decidirEscalon(RD, ESCALONES_RD, { venta: 150000, subtotal: 140000 }, 20))
      .toEqual({ paga: false, motivo: 'bajo_umbral' });
  });

  it('el markup no decide en RD, aunque falte el costo', () => {
    const d = decidirEscalon(RD, ESCALONES_RD, { venta: 200000, subtotal: 185000 }, null) as any;
    expect(d.paga).toBe(true);
    expect(d.pct).toBe(3.75);
    expect(d.base).toBe(185000);
    expect(d.chofer_bajo_piso).toBe(false);
  });

  it('elegirEscalon: min inclusivo, max exclusivo', () => {
    expect(elegirEscalon(ESCALONES_RD, 250000)?.pct).toBe(5);
    expect(elegirEscalon(ESCALONES_RD, 189999.98)).toBeNull();
  });
});
