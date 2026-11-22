import {
  asuntoDelAviso, enmascarar, faltantesDelAviso, ligaCorreo, ligaWhatsApp, normalizarCorreo, normalizarWhatsApp, textoDelAviso,
  type AvisoDePago, type FacturaDelAviso,
} from './aviso-de-pago.contract';

const factura = (o: Partial<FacturaDelAviso> = {}): FacturaDelAviso => ({
  referencia: 'A-1001', documento: 'X-A-20 0000683', uuid: '11111111-2222-3333-4444-555555555555', metodo: 'PPD', fecha: '2026-10-09', total: 3000,
  notas: [], descuento: 0, pagado: 1000, ...o,
});
const aviso = (o: Partial<AvisoDePago> = {}): AvisoDePago => ({
  pago_id: 'P1', emisor: { nombre: 'EMPRESA DE PRUEBA', rfc: 'EPR010101AAA' }, proveedor: { codigo: 'P01', nombre: 'PROVEEDOR UNO', rfc: 'PUN010101BBB' },
  fecha_pago: '2026-11-09', importe: 1000, rastreo: 'RASTREO123', origen: 'BBVA ···4166', destino: '···6033', comprobante_id: 'C1',
  facturas: [factura()], contacto: null, avisos: [], faltantes: [], se_puede: true, motivo: null, ...o,
});

describe('[PGP.194] el aviso de pago: teléfono y correo', () => {
  it('⭐ el WhatsApp queda a 12 dígitos con lada 52, venga como venga', () => {
    expect(normalizarWhatsApp('351 123 4567')).toBe('523511234567');
    expect(normalizarWhatsApp('+52 (351) 123-4567')).toBe('523511234567');
    expect(normalizarWhatsApp('5213511234567')).toBe('523511234567');
    expect(normalizarWhatsApp('0443511234567')).toBe('523511234567');
  });
  it('⛔ NEGATIVA: un número incompleto o de otro país no se inventa', () => {
    expect(normalizarWhatsApp('351123456')).toBeNull();
    expect(normalizarWhatsApp('13511234567')).toBeNull();
    expect(normalizarWhatsApp('')).toBeNull();
    expect(normalizarWhatsApp(null)).toBeNull();
  });
  it('correo: se limpia y se valida la forma; ⛔ dos correos o sin dominio, no', () => {
    expect(normalizarCorreo('  Cobranza@Proveedor.COM ')).toBe('cobranza@proveedor.com');
    expect(normalizarCorreo('cobranza@proveedor')).toBeNull();
    expect(normalizarCorreo('a@b.com, c@d.com')).toBeNull();
    expect(normalizarCorreo('sin arroba.com')).toBeNull();
  });
  it('la cuenta va enmascarada: sólo los últimos 4', () => {
    expect(enmascarar('002320094300416033')).toBe('···6033');
    expect(enmascarar('BBVA 0489962182')).toBe('···2182');
    expect(enmascarar(null)).toBeNull();
  });
});

describe('[PGP.194] el aviso de pago: lo que dice y lo que declara', () => {
  it('⭐ completo: nada que declarar', () => {
    expect(faltantesDelAviso(aviso())).toEqual([]);
  });
  it('⛔ sin comprobante o sin rastreo, se dice', () => {
    expect(faltantesDelAviso(aviso({ comprobante_id: null }))[0]).toMatch(/sin comprobante anexo/);
    expect(faltantesDelAviso(aviso({ rastreo: null }))[0]).toMatch(/clave de rastreo/);
  });
  it('⛔ una factura sin CFDI ligado se cuenta, no se omite', () => {
    const f = faltantesDelAviso(aviso({ facturas: [factura(), factura({ uuid: null })] }));
    expect(f).toEqual(['1 de 2 facturas sin CFDI ligado: va con su referencia, sin UUID.']);
  });
  it('⭐ el mensaje lleva fecha, importe, rastreo, las referencias y la liga, y pide el REP', () => {
    const t = textoDelAviso(aviso(), 'https://suite.prueba/api/finance/payment-notice/tok/aviso.pdf');
    expect(t).toContain('09/11/2026');
    expect(t).toContain('$1,000.00');
    expect(t).toContain('RASTREO123');
    expect(t).toContain('A-1001');
    expect(t).toContain('https://suite.prueba/api/finance/payment-notice/tok/aviso.pdf');
    expect(t).toMatch(/complemento de pago \(REP\)/);
  });
  it('con muchas facturas, nombra 6 y cuenta el resto', () => {
    const muchas = Array.from({ length: 9 }, (_, i) => factura({ referencia: `F-${i + 1}` }));
    expect(textoDelAviso(aviso({ facturas: muchas }), 'u')).toContain('F-1, F-2, F-3, F-4, F-5, F-6 y 3 más.');
  });
  it('sin rastreo no inventa uno', () => {
    expect(textoDelAviso(aviso({ rastreo: null }), 'u')).not.toContain('rastreo');
  });
  it('las ligas: wa.me con el número (o sin él) y mailto con asunto y cuerpo', () => {
    expect(ligaWhatsApp('3511234567', 'hola y adiós')).toBe('https://wa.me/523511234567?text=hola%20y%20adi%C3%B3s');
    expect(ligaWhatsApp('123', 'x')).toBe('https://wa.me/?text=x');
    const m = ligaCorreo('cobranza@proveedor.com', asuntoDelAviso(aviso()), 'cuerpo');
    expect(m.startsWith('mailto:cobranza@proveedor.com?subject=Aviso%20de%20pago%20EMPRESA%20DE%20PRUEBA')).toBe(true);
    expect(m).toContain('&body=cuerpo');
    expect(ligaCorreo('no-es-correo', 'a', 'b')).toBe('mailto:?subject=a&body=b');
  });
});
