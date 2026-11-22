import { LARGO_NOTA_CIERRE, MOTIVOS_CIERRE_COTIZACION, motivoDeCierreCotizacion, textoDeCierreCotizacion } from './quote-close.contract';

describe('[COT.52] motivos de cierre de una cotización', () => {
  it('el código va siempre primero, para poder contarlos después', () => {
    expect(textoDeCierreCotizacion('precio')).toBe('precio');
    expect(textoDeCierreCotizacion('otro', '  el cliente cerró su tienda ')).toBe('otro — el cliente cerró su tienda');
    expect(motivoDeCierreCotizacion('otro — el cliente cerró su tienda')).toBe('otro');
    expect(motivoDeCierreCotizacion('sin_existencia')).toBe('sin_existencia');
  });

  it('un texto libre de antes (o basura) no se cuenta como un motivo', () => {
    expect(motivoDeCierreCotizacion('duplicada')).toBeNull();
    expect(motivoDeCierreCotizacion(null)).toBeNull();
  });

  it('la nota se recorta a su tope', () => {
    expect(textoDeCierreCotizacion('otro', 'x'.repeat(LARGO_NOTA_CIERRE + 50)).length).toBe('otro — '.length + LARGO_NOTA_CIERRE);
  });

  it('cada motivo lleva a rechazada (el cliente no compró) o cancelada (baja nuestra), sin repetir código', () => {
    const codigos = MOTIVOS_CIERRE_COTIZACION.map((m) => m.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(MOTIVOS_CIERRE_COTIZACION.every((m) => m.estado === 'rejected' || m.estado === 'cancelled')).toBe(true);
    // Sólo el cliente decide una venta perdida: «prueba» y «otro» no la inflan.
    expect(MOTIVOS_CIERRE_COTIZACION.filter((m) => m.estado === 'cancelled').map((m) => m.codigo)).toEqual(['prueba', 'otro']);
  });
});
