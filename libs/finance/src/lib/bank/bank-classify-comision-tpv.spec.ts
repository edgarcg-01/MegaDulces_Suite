import { compileRules, classifyWith, type ClassifyRuleRow } from './finance-bank.service';

/**
 * `[CB.52]` — **La comisión de terminal punto de venta no es un pago de crédito.**
 *
 * El concepto que manda BBVA por cobrar una venta con tarjeta es
 * `APLI TASA DE DES CREDITO/175096838 TERMINALES PUNTO DE VENTA`. La regla `priority 142`
 * (`code ^612$`, concepto `CAPITAL|CREDITO|…`) lo tomaba por la palabra **CREDITO**. Medido en
 * prod el 2026-10-20, la misma comisión estaba repartida en cuatro estados: **770** en
 * `pago_credito`, **792** sin categoría (la variante `DEBITO`, que no tomaba ninguna regla),
 * **21** en `cobranza` y **7** en `iva_acreditable` — **1,590 movimientos / $342,603.91**.
 *
 * ⚠️ **El riesgo que este candado cuida no es el falso negativo, es el falso POSITIVO.** La
 * frase `TERMINALES PUNTO DE VENTA` aparece también en el **depósito** de la venta con
 * tarjeta — **647 movimientos / $4,975,481.93** que hoy están bien en `cobranza`. Una regla
 * escrita por esa frase sola convertiría cinco millones de pesos de ingreso en comisión. Por
 * eso el caso `depósito de venta con tarjeta` de abajo no es decoración: es el que importa.
 *
 * ⚠️ **Y la prioridad es parte del arreglo, no un detalle.** Las reglas nuevas van en **54 y
 * 55**, arriba de `61` (`type ^I$` → cobranza) y `70` (`code ^102$` → cobranza): 21 de esas
 * comisiones vienen capturadas con el código del depósito, así que una regla correcta colocada
 * en los 130 no las vería nunca. La tercera prueba negativa es exactamente ésa.
 *
 * Las reglas de abajo son las de prod (`finance.bank_classify_rules`, tenant mega_dulces) en
 * el tramo que decide estos conceptos — no un catálogo inventado para la prueba.
 */

/** Las dos que agrega la migración `20261020151727`. */
const REGLA_IVA: ClassifyRuleRow = { priority: 54, match_type: null, match_code: null, match_concept: '^IVA TASA DE DES', category_code: 'iva_acreditable' };
const REGLA_COMISION: ClassifyRuleRow = { priority: 55, match_type: null, match_code: null, match_concept: 'TASA DE DES(C)? (CREDITO|DEBITO)', category_code: 'comision_bancaria' };

/** El tramo real del catálogo de prod que compite por estos conceptos. */
const REGLAS: ClassifyRuleRow[] = [
  { priority: 50, match_type: '^ID$', match_code: null, match_concept: null, category_code: 'ingreso_devolucion' },
  REGLA_IVA,
  REGLA_COMISION,
  { priority: 60, match_type: '^I$', match_code: null, match_concept: 'DEV|DEVOLUC', category_code: 'ingreso_devolucion' },
  { priority: 61, match_type: '^I$', match_code: null, match_concept: null, category_code: 'cobranza' },
  { priority: 70, match_type: null, match_code: '^102$', match_concept: null, category_code: 'cobranza' },
  { priority: 100, match_type: null, match_code: '^147$', match_concept: null, category_code: 'iva_acreditable' },
  { priority: 130, match_type: null, match_code: '^(612|613)$', match_concept: 'DISPOSICION POR POS|COMPRA - DISPOSICION', category_code: 'compra_tarjeta' },
  { priority: 133, match_type: null, match_code: '^(612|613)$', match_concept: 'RENTA TERMINAL|RENTA TPV|RENTA DE TERMINAL', category_code: 'comision_bancaria' },
  { priority: 140, match_type: null, match_code: '^612$', match_concept: 'SUA|IMSS', category_code: 'imss_sua' },
  { priority: 141, match_type: null, match_code: '^612$', match_concept: 'COMISI|MEMBRES|COBRO', category_code: 'comision_bancaria' },
  { priority: 142, match_type: null, match_code: '^612$', match_concept: 'CAPITAL|CREDITO|CRÉDITO|PRESTAMO|PRÉSTAMO', category_code: 'pago_credito' },
  { priority: 160, match_type: null, match_code: null, match_concept: 'PAGO INTERES|INTERESES?\\b|ABONO AL? PRESTAMO|ABONO PRESTAMO', category_code: 'pago_credito' },
];

/** Conceptos textuales de prod, copiados tal cual del estado de cuenta. */
const CASOS: Array<{ nombre: string; M: string; C: string | null; concepto: string; espera: string }> = [
  {
    nombre: 'comisión TPV crédito → comisión bancaria',
    M: 'G', C: '612',
    concepto: 'APLI TASA DE DES CREDITO/175096838 TERMINALES PUNTO DE VENTA',
    espera: 'comision_bancaria',
  },
  {
    nombre: 'comisión TPV débito → comisión bancaria (antes no la tomaba ninguna regla)',
    M: 'G', C: '612',
    concepto: 'APLI TASA DE DES DEBITO/175096833 TERMINALES PUNTO DE VENTA',
    espera: 'comision_bancaria',
  },
  {
    nombre: 'comisión capturada con el código del depósito → comisión, no cobranza',
    M: 'I', C: '102',
    concepto: 'APLI TASA DE DES CREDITO/175096838 TERMINALES PUNTO DE VENTA',
    espera: 'comision_bancaria',
  },
  {
    nombre: 'comisión sin código de renglón → comisión bancaria',
    M: 'G', C: null,
    concepto: 'APLI TASA DE DES DEBITO/175096860 TERMINALES PUNTO DE VENTA',
    espera: 'comision_bancaria',
  },
  {
    nombre: 'IVA de esa comisión, capturado con el código del gasto → IVA acreditable',
    M: 'G', C: '612',
    concepto: 'IVA TASA DE DESC DEBITO/175096833 TERMINALES PUNTO DE VENTA',
    espera: 'iva_acreditable',
  },
  {
    nombre: 'IVA de esa comisión con su código propio → IVA acreditable',
    M: 'G', C: '147',
    concepto: 'IVA TASA DE DESC CREDITO/175096838 TERMINALES PUNTO DE VENTA',
    espera: 'iva_acreditable',
  },
  {
    nombre: '⚠️ depósito de venta con tarjeta → sigue siendo cobranza, NO comisión',
    M: 'I', C: '102',
    concepto: 'ABONO TERMINALES PUNTO DE VENTA 175096838',
    espera: 'cobranza',
  },
  {
    nombre: 'pago de capital del crédito → sigue siendo pago de crédito',
    M: 'G', C: '612',
    concepto: 'PAGO DE CAPITAL 089386050',
    espera: 'pago_credito',
  },
  {
    nombre: 'pago de intereses del crédito → sigue siendo pago de crédito',
    M: 'G', C: '612',
    concepto: 'PAGO DE INTERESES 087710424',
    espera: 'pago_credito',
  },
  {
    nombre: 'renta de terminal → comisión bancaria (regla 133, no la toca la nueva)',
    M: 'G', C: '612',
    concepto: 'RENTA TERMINAL PUNTO DE VENTA',
    espera: 'comision_bancaria',
  },
  {
    nombre: 'cobro normal con código 102 → cobranza (la regla 70 sigue intacta)',
    M: 'I', C: '102',
    concepto: 'Deposito en Efectivo por 10,953.68 mxn | Recibo # 37070037600',
    espera: 'cobranza',
  },
];

const COMISION_CREDITO = 'APLI TASA DE DES CREDITO/175096838 TERMINALES PUNTO DE VENTA';

describe('[CB.52] clasificación de la comisión de terminal punto de venta', () => {
  const compiladas = compileRules(REGLAS);

  for (const caso of CASOS) {
    it(caso.nombre, () => {
      expect(classifyWith(compiladas, caso.M, caso.C, caso.concepto)).toBe(caso.espera);
    });
  }

  it('PRUEBA NEGATIVA: sin la regla de comisión, vuelve a caer en pago_credito', () => {
    const sinLaRegla = compileRules(REGLAS.filter((r) => r !== REGLA_COMISION));
    expect(classifyWith(sinLaRegla, 'G', '612', COMISION_CREDITO)).toBe('pago_credito');
  });

  it('PRUEBA NEGATIVA: sin la regla de comisión, la variante DEBITO se queda sin clasificar', () => {
    const sinLaRegla = compileRules(REGLAS.filter((r) => r !== REGLA_COMISION));
    expect(
      classifyWith(sinLaRegla, 'G', '612', 'APLI TASA DE DES DEBITO/175096833 TERMINALES PUNTO DE VENTA'),
    ).toBe('sin_clasificar');
  });

  it('PRUEBA NEGATIVA: con la regla correcta pero por debajo de la 70, la comisión con código 102 se pierde en cobranza', () => {
    const degradada = compileRules([
      ...REGLAS.filter((r) => r !== REGLA_COMISION),
      { ...REGLA_COMISION, priority: 139 },
    ]);
    expect(classifyWith(degradada, 'I', '102', COMISION_CREDITO)).toBe('cobranza');
    // …y la de 612, que no compite con la 70, sí la toma: por eso el defecto sería invisible.
    expect(classifyWith(degradada, 'G', '612', COMISION_CREDITO)).toBe('comision_bancaria');
  });
});
