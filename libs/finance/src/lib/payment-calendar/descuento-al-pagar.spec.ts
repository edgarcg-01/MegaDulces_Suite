import { assertDescuentoPermitido, normalizarDescuento, rotuloDescuento, round2 } from './descuento-al-pagar';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';

/**
 * `[PGP.51]` **El descuento al pagar, sin base de datos.** Lo que se prueba es la ÚNICA regla que
 * decide si un descuento capturado vale: la usan `createAllocation` y `addItem`. La parte que toca
 * la base (que lo cubierto no se vuelva a ofrecer) vive en `payment-calendar.it.spec.ts`.
 */
describe('[PGP.51] normalizarDescuento — se paga el neto, se cubre la factura', () => {
  it('sin descuento: deja el item como estaba (0 / null) y lo cubierto es el neto', () => {
    expect(normalizarDescuento({ applied_amount: 9000 })).toEqual({
      applied_amount: 9000, discount_amount: 0, discount_reason: null, discount_rate: null, discount_note: null, covered: 9000,
    });
  });

  it('⭐ el ejemplo de Francisco: 3 % de pronto pago sobre $38,880 → se transfieren $37,713.60', () => {
    const r = normalizarDescuento({ applied_amount: 37713.6, discount_amount: 1166.4, discount_reason: 'pronto_pago', discount_rate: 0.03 });
    expect(r.applied_amount).toBe(37713.6);
    expect(r.discount_amount).toBe(1166.4);
    expect(r.discount_reason).toBe('pronto_pago');
    expect(r.discount_rate).toBe(0.03);
    expect(r.covered).toBe(38880);
  });

  it('descuento capturado en PESOS: no hay tasa que verificar ni que guardar', () => {
    const r = normalizarDescuento({ applied_amount: 4750, discount_amount: 250, discount_reason: 'volumen', discount_rate: null });
    expect(r.discount_rate).toBeNull();
    expect(r.covered).toBe(5000);
  });

  it('redondea a centavos lo que llega con decimales de más', () => {
    const r = normalizarDescuento({ applied_amount: '100.004', discount_amount: '0.996', discount_reason: 'volumen' });
    expect(r.applied_amount).toBe(100);
    expect(r.discount_amount).toBe(1);
    expect(round2(1.005)).toBe(1.01);
  });

  it('acepta un redondeo de ±1 centavo entre la tasa y el descuento', () => {
    // 3 % de 1,000.33 = 30.0099 → 30.01; si la pantalla mandó 30.00 también pasa (1 centavo).
    expect(() => normalizarDescuento({ applied_amount: 970.33, discount_amount: 30, discount_reason: 'pronto_pago', discount_rate: 0.03 })).not.toThrow();
  });

  it('el detalle se guarda recortado; vacío es null', () => {
    expect(normalizarDescuento({ applied_amount: 90, discount_amount: 10, discount_reason: 'otro', discount_note: '  bonificación de temporada ' }).discount_note)
      .toBe('bonificación de temporada');
    expect(normalizarDescuento({ applied_amount: 90, discount_amount: 10, discount_reason: 'volumen', discount_note: '   ' }).discount_note).toBeNull();
  });

  // ── Rechazos: cada uno es una captura que hoy terminaría en un neto mal calculado ──────────
  it('⛔ «Otro» sin detalle', () => {
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: 10, discount_reason: 'otro' })).toThrow(/Otro/);
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: 10, discount_reason: 'otro', discount_note: '  ' })).toThrow(/Otro/);
  });

  it('⛔ descuento sin motivo', () => {
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: 10 })).toThrow(/motivo/);
  });

  it('⛔ motivo sin descuento (y tasa sin descuento)', () => {
    expect(() => normalizarDescuento({ applied_amount: 90, discount_reason: 'pronto_pago' })).toThrow(/cero/);
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: 0, discount_rate: 0.03 })).toThrow(/tasa/);
  });

  it('⛔ motivo fuera de la lista cerrada', () => {
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: 10, discount_reason: 'regalo' })).toThrow(/inválido/);
  });

  it('⛔ la tasa no cuadra con el descuento: el servidor revisa la cuenta', () => {
    // 2 % de 5,000 son 100, no 150.
    expect(() => normalizarDescuento({ applied_amount: 4850, discount_amount: 150, discount_reason: 'volumen', discount_rate: 0.02 })).toThrow(/no cuadra/);
    // A dos centavos ya no es redondeo.
    expect(() => normalizarDescuento({ applied_amount: 970.31, discount_amount: 30.02, discount_reason: 'pronto_pago', discount_rate: 0.03 })).not.toThrow();
    expect(() => normalizarDescuento({ applied_amount: 970.30, discount_amount: 30.03, discount_reason: 'pronto_pago', discount_rate: 0.03 })).toThrow(/no cuadra/);
  });

  it('⛔ tasa fuera de (0, 1): 0 %, 100 % o un «3» que quiso decir 3 %', () => {
    for (const rate of [0, 1, 3, -0.03]) {
      expect(() => normalizarDescuento({ applied_amount: 97, discount_amount: 3, discount_reason: 'volumen', discount_rate: rate })).toThrow(/entre 0 y 100/);
    }
  });

  it('⛔ descuento negativo o no numérico', () => {
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: -10, discount_reason: 'volumen' })).toThrow(/mayor o igual a cero/);
    expect(() => normalizarDescuento({ applied_amount: 90, discount_amount: 'diez', discount_reason: 'volumen' })).toThrow(/mayor o igual a cero/);
  });

  it('⛔ el neto tiene que ser > 0: un descuento del 100 % no es un pago', () => {
    expect(() => normalizarDescuento({ applied_amount: 0, discount_amount: 100, discount_reason: 'volumen' })).toThrow(/applied_amount/);
    expect(() => normalizarDescuento({ applied_amount: 0.001 })).toThrow(/applied_amount/);
  });
});

describe('[PGP.51] rotuloDescuento — cómo se lee en el papel', () => {
  it('con tasa dice el porcentaje; en pesos, sólo el motivo', () => {
    expect(rotuloDescuento('pronto_pago', 0.03)).toBe('Pronto pago 3 %');
    expect(rotuloDescuento('volumen', '0.025000')).toBe('Volumen 2.5 %');
    expect(rotuloDescuento('volumen', null)).toBe('Volumen');
    expect(rotuloDescuento('otro', undefined)).toBe('Otro');
  });
});

describe('[PGP.51] revisión — lo que la primera versión dejaba pasar', () => {
  it('⛔ una tasa que se redondea a 0 se rechaza con mensaje, no con el CHECK de la base (500)', () => {
    expect(() => normalizarDescuento({ applied_amount: 100, discount_amount: 0.01, discount_reason: 'volumen', discount_rate: 1e-7 })).toThrow(/entre 0 y 100/);
    expect(() => normalizarDescuento({ applied_amount: 0.01, discount_amount: 100, discount_reason: 'volumen', discount_rate: 0.9999996 })).toThrow(/entre 0 y 100/);
  });

  it('⛔ el descuento sólo va en facturas de proveedor (las que reciben nota de crédito)', () => {
    expect(() => assertDescuentoPermitido('budget_expense', 'gasto', 300)).toThrow(/facturas de proveedor/);
    expect(() => assertDescuentoPermitido('financial_commitment', 'compromiso_financiero', 300)).toThrow(/facturas de proveedor/);
    // ⛔ Lo que encontró la prueba visual: un préstamo de socio llega de Kepler como kepler_payable.
    expect(() => assertDescuentoPermitido('kepler_payable', 'compromiso_financiero', 300)).toThrow(/facturas de proveedor/);
    // Control: las dos fuentes de factura de mercancía lo aceptan, y sin descuento nada se toca.
    expect(() => assertDescuentoPermitido('kepler_payable', 'proveedor_mercancia', 300)).not.toThrow();
    expect(() => assertDescuentoPermitido('supplier_payable', 'proveedor_mercancia', 300)).not.toThrow();
    expect(() => assertDescuentoPermitido('kepler_payable', 'compromiso_financiero', 0)).not.toThrow();
  });
});

describe('[PGP.51b] la vista «qué conviene pagar» usa LA MISMA llave que el Calendario', () => {
  it('la condición de la migración contiene sqlKeplerPayableId(v) tal cual (si se separan, deja de excluir sin error)', () => {
    const mig = readFileSync(resolve(__dirname, '../../../../../database/migrations-newdb/20261103171051_pgp51b_que_pagar_sin_el_sobrante_del_descuento.js'), 'utf8');
    expect(mig).toContain(sqlKeplerPayableId('v'));
  });
});
