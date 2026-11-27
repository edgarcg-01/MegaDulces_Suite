import { pagoDelChofer } from './commission-piso-pago.logic';

/**
 * `[RD.C1.0b]` — **El piso de cero, con su prueba negativa.**
 *
 * Una compuerta sin prueba negativa es una intención: la primera prueba de acá está construida
 * **a propósito** para dar negativo con la fórmula vieja (`comisión + bonos − nómina`), y
 * verifica que salga **0 y lo declare** — no que desaparezca, no que se vuelva negativa.
 *
 * El hecho que la justifica, medido en prod el 2026-11-27: de las **304 líneas de chofer** del
 * libro, **48** tenían resta negativa y las **48** pagaron **$0.00**; pagos negativos, **0**.
 */
describe('[RD.C1.0b] el piso de cero del pago al chofer', () => {
  it('⛔ PRUEBA NEGATIVA: una línea armada para dar negativo sale 0 y lo DECLARA', () => {
    // Con la fórmula vieja: 1,200 + 0 − 5,000 = −3,800.
    const p = pagoDelChofer(1200, 0, 5000);

    expect(p.a_pagar).toBe(0);                    // no negativo
    expect(p.deduccion_status).toBe('tope_piso'); // y no se disfraza de 'aplicada'
    expect(p.deduccion_aplicada).toBe(1200);
    expect(p.deduccion_no_aplicada).toBe(3800);   // ⭐ los pesos que NO se descontaron, publicados
    // cada peso, una explicación: lo mandado = lo aplicado + lo que no cupo
    expect(p.deduccion_aplicada + p.deduccion_no_aplicada).toBe(5000);
  });

  it('el caso normal no cambia: la deducción cabe y se resta entera', () => {
    const p = pagoDelChofer(5244.83, 0, 5000);    // la línea REAL más cerca del piso (ruta 501)
    expect(p.a_pagar).toBe(244.83);
    expect(p.deduccion_status).toBe('aplicada');
    expect(p.deduccion_no_aplicada).toBe(0);
  });

  it('sin nómina configurada no hay deducción, y el bruto se paga entero', () => {
    const p = pagoDelChofer(3000, 450.5, 0);
    expect(p.a_pagar).toBe(3450.5);
    expect(p.deduccion_status).toBe('no_aplica');
    expect(p.deduccion_aplicada).toBe(0);
  });

  it('el borde exacto —la nómina igual al bruto— paga 0 pero NO es tope_piso', () => {
    const p = pagoDelChofer(4000, 1000, 5000);
    expect(p.a_pagar).toBe(0);
    expect(p.deduccion_status).toBe('aplicada'); // se aplicó entera: no quedó nada sin descontar
    expect(p.deduccion_no_aplicada).toBe(0);
  });

  it('los bonos entran al bruto antes del piso (si no, el piso dispararía de más)', () => {
    const sinBono = pagoDelChofer(4000, 0, 5000);
    const conBono = pagoDelChofer(4000, 1500, 5000);
    expect(sinBono.deduccion_status).toBe('tope_piso');
    expect(conBono.a_pagar).toBe(500);
    expect(conBono.deduccion_status).toBe('aplicada');
  });

  it('redondea a centavos una sola vez, al final', () => {
    const p = pagoDelChofer(1000.005, 0.004, 0);
    expect(p.a_pagar).toBe(1000.01);
  });
});
