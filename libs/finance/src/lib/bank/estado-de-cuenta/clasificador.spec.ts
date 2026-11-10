import { clasificarRenglon } from './clasificador';

// Conceptos con la forma de los estados de cuenta reales; números de terminal e importes inventados.
const sale = (concepto: string, extra = {}) => clasificarRenglon({ amount_in: 0, amount_out: 10, concepto, ...extra });
const entra = (concepto: string, extra = {}) => clasificarRenglon({ amount_in: 10, amount_out: 0, concepto, ...extra });

describe('[CB.61] clasificarRenglon — la categoría sin M/C', () => {
  it('los cargos del propio banco salen del texto del banco', () => {
    expect(sale('IVA TASA DE DESC DEBITO/100000001 TERMINALES PUNTO DE VENTA')).toEqual({ categoria: 'iva_acreditable', por: 'banco' });
    expect(sale('APLI TASA DE DES CREDITO/100000001 TERMINALES PUNTO DE VENTA').categoria).toBe('comision_bancaria');
    expect(sale('COM VTAS TDC INTER/100000001 123').categoria).toBe('comision_bancaria');
    expect(sale('I V A POR COMISION').categoria).toBe('iva_acreditable');
    expect(sale('RENTA TERMINAL PUNTO DE VENTA').categoria).toBe('comision_bancaria');
    expect(sale('Compra - Disposicion por POS por (1,000.00) mxn en SUPER').categoria).toBe('compra_tarjeta');
  });

  it('el documento de Kepler casado manda sobre el texto', () => {
    expect(entra('DEP.EFECTIVO', { doc_tipo: 'U-A-5' })).toEqual({ categoria: 'cobranza', por: 'documento' });
    expect(sale('SPEI ENVIADO', { doc_tipo: 'N-A-26' }).categoria).toBe('traspaso_entre_cuentas');
    expect(sale('PROVEEDOR SA DE CV', { doc_tipo: 'X-D-26', entidad: 'CD001' }).categoria).toBe('compra_mercancia');
    expect(sale('PAGO', { doc_tipo: 'X-D-26', entidad: 'GN001' }).categoria).toBe('nomina');
  });

  it('[negativa] «COMISION» del banco NO es comisión de venta, aunque la regla genérica del libro lo diga', () => {
    const libro = () => 'comisiones_venta';
    expect(clasificarRenglon({ amount_in: 0, amount_out: 5, concepto: 'COMISION 0001CAPLICACION DE TASAS' }, libro).categoria).toBe('comision_bancaria');
  });

  it('[negativa] las reglas del libro no se aplican a un depósito («VENTAS TDC» no es compra con tarjeta)', () => {
    const libro = () => 'compra_tarjeta';
    expect(clasificarRenglon({ amount_in: 50, amount_out: 0, concepto: 'VENTAS TDC INTER/100000001 9' }, libro)).toEqual({ categoria: 'cobranza', por: 'deposito' });
    expect(clasificarRenglon({ amount_in: 0, amount_out: 50, concepto: 'PAGO SAT' }, () => 'impuestos')).toEqual({ categoria: 'impuestos', por: 'regla_del_libro' });
  });

  it('[negativa] un retiro sin señal NO se adivina; una entidad de gasto genérico tampoco', () => {
    expect(sale('SPEI ENVIADO PROVEEDOR X')).toEqual({ categoria: 'sin_clasificar', por: 'ninguna' });
    expect(sale('PAGO', { doc_tipo: 'X-D-26', entidad: 'GB001' })).toEqual({ categoria: 'sin_clasificar', por: 'ninguna' });
  });

  it('depósitos: devolución y traspaso se nombran; lo demás es cobranza declarada por ser depósito', () => {
    expect(entra('SPEI DEVUELTOBANORTE/1').categoria).toBe('devolucion_spei');
    expect(entra('TRASPASO ENTRE CTAS 1').categoria).toBe('traspaso_entre_cuentas');
    expect(entra('ANUL O BONI IVA COM')).toEqual({ categoria: 'sin_clasificar', por: 'ninguna' });
    expect(entra('VENTAS DEBITO/100000001 TERMINALES PUNTO DE VENTA')).toEqual({ categoria: 'cobranza', por: 'deposito' });
  });
});
