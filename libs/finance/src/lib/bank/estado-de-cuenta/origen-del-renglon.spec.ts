import { claveDeEntrada, NOMBRE_DE_ORIGEN, ORDEN_DE_ORIGEN, senalDelBanco } from './origen-del-renglon';

describe('[BFU.4.5.12] senalDelBanco — lo que dice el banco de un depósito sin documento', () => {
  it.each([
    ['VENTAS CREDITO/0012 TERMINALES PUNTO DE VENTA', 'terminal'],
    ['VENTAS DEBITO/0012 TERMINALES PUNTO DE VENTA', 'terminal'],
    ['DEPOSITO EN EFECTIVO/0000777', 'efectivo'],
    ['DEP.EFECTIVO REF12 NSC3IDND4', 'efectivo'],
    ['Depósito de efectivo sucursal: 12', 'efectivo'],
    ['ABONO TRANSFERENCIA SPEI', 'transferencia'],
    ['TRASPASO CUENTAS PROPIAS/ 123 CUENTA: 456 BNET', 'transferencia'],
    ['DEPOSITO DE PRESTAMO/0000123', 'prestamo'],
    ['ABONO POR DEVOLUCION SUCURSAL: 1', 'devolucion'],
    ['SPEI DEVUELTOSANTANDER/123', 'devolucion'],
    ['DULCERIA LOS ALTOS 12C', 'otro'],
    [null, 'otro'],
  ])('%s → %s', (concepto, senal) => expect(senalDelBanco(concepto)).toBe(senal));

  it('⛔ [negativa] «VENTAS CREDITO … TERMINALES» es venta con tarjeta de crédito, NO un préstamo', () => {
    expect(senalDelBanco('VENTAS CREDITO/0001 TERMINALES PUNTO DE VENTA')).not.toBe('prestamo');
  });
  it('⛔ [negativa] un préstamo depositado no es «depósito en efectivo» aunque diga DEPOSITO y EFECTIVO', () => {
    expect(senalDelBanco('DEPOSITO DE PRESTAMO EN EFECTIVO')).toBe('prestamo');
  });
});

describe('[BFU.4.5.12] claveDeEntrada — el origen de lo que entró', () => {
  it('manda el documento: venta de tienda, cobranza, traspaso, otro', () => {
    for (const o of ['venta_tienda', 'cobranza', 'traspaso', 'otro_documento']) {
      expect(claveDeEntrada({ origen_doc: o, concepto: 'DEPOSITO EN EFECTIVO' })).toBe(o);
    }
  });
  it('sin documento: la categoría que lo dice, el cliente declarado, y si no, lo que dice el banco', () => {
    expect(claveDeEntrada({ categoria: 'traspaso_entre_cuentas' })).toBe('traspaso');
    expect(claveDeEntrada({ categoria: 'devolucion_spei' })).toBe('devolucion');
    expect(claveDeEntrada({ categoria: 'cobranza', cliente: true })).toBe('cobranza');
    expect(claveDeEntrada({ categoria: 'cobranza', concepto: 'VENTAS DEBITO/1 TERMINALES PUNTO DE VENTA' })).toBe('sin_documento:terminal');
  });
  it('⛔ [negativa] la categoría «cobranza» puesta por ser depósito NO vuelve cobranza a un depósito sin documento (D8)', () => {
    expect(claveDeEntrada({ categoria: 'cobranza', concepto: 'DEPOSITO EN EFECTIVO' })).toBe('sin_documento:efectivo');
  });
  it('⛔ [negativa] un origen de documento desconocido no se cree: cae a lo que dice el banco', () => {
    expect(claveDeEntrada({ origen_doc: 'inventado', concepto: 'ABONO TRANSFERENCIA SPEI' })).toBe('sin_documento:transferencia');
  });
  it('todo grupo posible tiene nombre y lugar en el orden', () => {
    const posibles = ['venta_tienda', 'cobranza', 'traspaso', 'devolucion', 'otro_documento',
      ...['terminal', 'efectivo', 'transferencia', 'prestamo', 'devolucion', 'otro'].map((s) => `sin_documento:${s}`)];
    for (const k of posibles) {
      expect(NOMBRE_DE_ORIGEN[k]).toBeTruthy();
      expect(ORDEN_DE_ORIGEN).toContain(k);
    }
  });
});
