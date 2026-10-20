import { compileRules, classifyWith, type ClassifyRuleRow } from './finance-bank.service';

/**
 * `[CB.52]` — **La comisión de terminal punto de venta no es un pago de crédito.**
 *
 * El concepto que manda BBVA por cobrar una venta con tarjeta es
 * `APLI TASA DE DES CREDITO/175096838 TERMINALES PUNTO DE VENTA`. La regla `priority 142`
 * (`code ^612$`, concepto `CAPITAL|CREDITO|…`) lo tomaba por la palabra **CREDITO** y lo
 * mandaba a `pago_credito`. Medido en prod el 2026-10-20: **781 movimientos / $203,047.77**
 * así, más **800 / $132,252.69** de la variante `DEBITO` que no tomaba ninguna regla y
 * quedaban sin categoría.
 *
 * ⚠️ **El riesgo que este candado cuida no es el falso negativo, es el falso POSITIVO.** La
 * frase `TERMINALES PUNTO DE VENTA` aparece también en el **depósito** de la venta con
 * tarjeta — 672 movimientos / **$4,983,804.98** que hoy están bien en `cobranza`. Una regla
 * escrita por esa frase sola convertiría cinco millones de pesos de ingreso en comisión. Por
 * eso el caso `deposito de venta con tarjeta` de abajo no es decoración: es el que importa.
 *
 * ── Prueba negativa ─────────────────────────────────────────────────────────────────────────
 * `sin la regla 139, la comisión vuelve a caer en pago_credito` corre el MISMO motor con el
 * catálogo sin la regla nueva y exige el resultado viejo. Si alguien borra o desactiva la
 * regla 139 y deja los otros casos verdes, ese test se pone rojo primero.
 *
 * Las reglas de abajo son las de prod (`finance.bank_classify_rules`, tenant mega_dulces) en
 * el tramo que decide estos conceptos — no un catálogo inventado para la prueba.
 */

/** El tramo real del catálogo de prod que compite por estos conceptos. */
const REGLAS: ClassifyRuleRow[] = [
  { priority: 61, match_type: '^I$', match_code: null, match_concept: null, category_code: 'cobranza' },
  { priority: 70, match_type: null, match_code: '^102$', match_concept: null, category_code: 'cobranza' },
  { priority: 100, match_type: null, match_code: '^147$', match_concept: null, category_code: 'iva_acreditable' },
  { priority: 130, match_type: null, match_code: '^(612|613)$', match_concept: 'DISPOSICION POR POS|COMPRA - DISPOSICION', category_code: 'compra_tarjeta' },
  { priority: 133, match_type: null, match_code: '^(612|613)$', match_concept: 'RENTA TERMINAL|RENTA TPV|RENTA DE TERMINAL', category_code: 'comision_bancaria' },
  // ── las dos que agrega la migración 20261020151727 ──
  { priority: 138, match_type: null, match_code: '^612$', match_concept: '^IVA TASA DE DES', category_code: 'iva_acreditable' },
  { priority: 139, match_type: null, match_code: '^612$', match_concept: 'TASA DE DES(C)? (CREDITO|DEBITO)', category_code: 'comision_bancaria' },
  // ── las preexistentes que competían ──
  { priority: 140, match_type: null, match_code: '^612$', match_concept: 'SUA|IMSS', category_code: 'imss_sua' },
  { priority: 141, match_type: null, match_code: '^612$', match_concept: 'COMISI|MEMBRES|COBRO', category_code: 'comision_bancaria' },
  { priority: 142, match_type: null, match_code: '^612$', match_concept: 'CAPITAL|CREDITO|CRÉDITO|PRESTAMO|PRÉSTAMO', category_code: 'pago_credito' },
  { priority: 160, match_type: null, match_code: null, match_concept: 'PAGO INTERES|INTERESES?\\b|ABONO AL? PRESTAMO|ABONO PRESTAMO', category_code: 'pago_credito' },
];

/** Conceptos textuales de prod, copiados tal cual del estado de cuenta. */
const CASOS: Array<{ nombre: string; M: string; C: string; concepto: string; espera: string }> = [
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
];

describe('[CB.52] clasificación de la comisión de terminal punto de venta', () => {
  const compiladas = compileRules(REGLAS);

  for (const caso of CASOS) {
    it(caso.nombre, () => {
      expect(classifyWith(compiladas, caso.M, caso.C, caso.concepto)).toBe(caso.espera);
    });
  }

  it('PRUEBA NEGATIVA: sin la regla 139, la comisión vuelve a caer en pago_credito', () => {
    const sinLaRegla = compileRules(REGLAS.filter((r) => r.priority !== 139));
    expect(
      classifyWith(sinLaRegla, 'G', '612', 'APLI TASA DE DES CREDITO/175096838 TERMINALES PUNTO DE VENTA'),
    ).toBe('pago_credito');
  });

  it('PRUEBA NEGATIVA: sin la regla 139, la variante DEBITO se queda sin clasificar', () => {
    const sinLaRegla = compileRules(REGLAS.filter((r) => r.priority !== 139));
    expect(
      classifyWith(sinLaRegla, 'G', '612', 'APLI TASA DE DES DEBITO/175096833 TERMINALES PUNTO DE VENTA'),
    ).toBe('sin_clasificar');
  });
});
