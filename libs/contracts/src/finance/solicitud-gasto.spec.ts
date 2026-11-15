import {
  alcanceDelAcreedor, avisoDeFechas, comentarioDeLaSolicitud, cuentaFueraDeAlcance, evidenciaEsElSat, faltaParaPedir, fechaReal, rfcCompatible,
  lineaAmpara, puedePedir, referenciaDelComprobante, totalesDeLaSolicitud, type EstadoSolicitudGasto,
} from './solicitud-gasto.contract';

/** Una solicitud completa y válida: la base de cada caso, que después se rompe en UNA cosa. */
const buena = (): EstadoSolicitudGasto => ({
  sucursal: '08', acreedor: 'GA022',
  renglones: [{ concepto: '240', proyecto: '2-15-26-02', departamento: '1-02-32-15', importe: 4740, cuenta: '602-008' }],
  iva: 758.4, fecha_solicitud: '2026-11-13',
  comprobante: { tipo: 'ticket', folio: '1198', fecha: '2026-11-12' },
  forma_pago: 'transferencia', forma_pago_detalle: '882301',
  archivos: [{ role: 'comprobante_1', live: true }],
});

describe('[PGP.122] alcanceDelAcreedor — DS3, firmado por Francisco el 2026-11-14', () => {
  it('entra el gasto operativo G…, incluidos GNF… (viáticos y arrastre) y los GN que no son nómina', () => {
    for (const c of ['GA022', 'GFS001', 'GG015', 'GNFC002', 'GN003', 'gfs001']) expect(alcanceDelAcreedor(c), c).toEqual({ dentro: true });
  });
  it('⛔ NEGATIVA — nómina, comisiones bancarias, tarjetas, préstamos, compras y sucursales se quedan en Kepler', () => {
    for (const c of ['GN001', 'GB004', 'TC001', 'A0001', 'C0001', 'TI001', '', null]) expect(alcanceDelAcreedor(c).dentro, String(c)).toBe(false);
  });
});

describe('[PGP.122] cuentaFueraDeAlcance — lo que no es gasto aunque pase por la solicitud', () => {
  it('SUA, impuestos, activo fijo y capital de créditos quedan fuera', () => {
    for (const c of ['601-015', '761-001', '762-001', '763-001', '150-009', '210-001']) expect(cuentaFueraDeAlcance(c), c).toMatch(/Kepler/);
  });
  it('el gasto entra, incluida la nómina-hermana 601-001 que no es SUA', () => {
    for (const c of ['602-008', '611-006', '601-001', '603-001', '1500-001', null]) expect(cuentaFueraDeAlcance(c), String(c)).toBeNull();
  });
});

describe('[PGP.122] totalesDeLaSolicitud — en centavos, como Kepler (c16 = Σ renglones + IVA)', () => {
  it('suma sin errores de punto flotante', () => {
    expect(totalesDeLaSolicitud([{ importe: 0.1 }, { importe: 0.2 }], 0.05)).toEqual({ subtotal: 0.3, iva: 0.05, total: 0.35 });
    expect(totalesDeLaSolicitud([{ importe: 4740 }], 758.4)).toEqual({ subtotal: 4740, iva: 758.4, total: 5498.4 });
  });
});

describe('[PGP.122] avisoDeFechas — DS15: fecha de solicitud y fecha del documento', () => {
  it('el mismo día no es retroactiva; un día antes sí (el gasto ya se hizo)', () => {
    expect(avisoDeFechas('2026-11-13', '2026-11-13')).toEqual({ ok: true, retroactiva: false });
    expect(avisoDeFechas('2026-11-12', '2026-11-13')).toEqual({ ok: true, retroactiva: true });
    expect(avisoDeFechas('2026-10-14', '2026-11-13')).toEqual({ ok: true, retroactiva: true });
  });
  it('más de 30 días u otro año: no bloquea, pide motivo', () => {
    expect(avisoDeFechas('2026-10-13', '2026-11-13')).toMatchObject({ ok: false, bloquea: false });
    expect(avisoDeFechas('2025-12-31', '2026-01-02')).toMatchObject({ ok: false, bloquea: false, motivo: expect.stringMatching(/2025/) });
  });
  it('⛔ NEGATIVA — un documento posterior a la solicitud, o sin fecha, bloquea', () => {
    expect(avisoDeFechas('2026-11-14', '2026-11-13')).toMatchObject({ ok: false, bloquea: true });
    expect(avisoDeFechas(null, '2026-11-13')).toMatchObject({ ok: false, bloquea: true });
    expect(avisoDeFechas('13/11/2026', '2026-11-13')).toMatchObject({ ok: false, bloquea: true });
  });
});

describe('[PGP.122] lineaAmpara — el formato que confirmó Francisco', () => {
  it('AMPARA <tipo> <folio> DEL dd/mm/aaaa, en 60 caracteres', () => {
    expect(lineaAmpara({ tipo: 'cfdi', folio: 'F-393/7537', fecha: '2026-11-09' })).toBe('AMPARA CFDI F-393/7537 DEL 09/11/2026');
    expect(lineaAmpara({ tipo: 'ticket', folio: null, fecha: '2026-11-09' })).toBe('AMPARA TICKET S/F DEL 09/11/2026');
    expect(lineaAmpara({ tipo: 'cotizacion', folio: 'COT 12', fecha: '2026-11-20' })).toBe('AMPARA COTIZACION COT 12 DEL 20/11/2026');
  });
  it('si no cabe se recorta el folio, nunca la fecha', () => {
    const l = lineaAmpara({ tipo: 'cotizacion', folio: 'X'.repeat(80), fecha: '2026-11-09' })!;
    expect(l.length).toBeLessThanOrEqual(60);
    expect(l.endsWith(' DEL 09/11/2026')).toBe(true);
  });
  it('⛔ NEGATIVA — sin fecha no hay renglón AMPARA (no se inventa)', () => {
    expect(lineaAmpara({ tipo: 'cfdi', folio: 'F-1', fecha: null })).toBeNull();
    expect(lineaAmpara(null)).toBeNull();
  });
});

describe('[PGP.122] referencia y comentario', () => {
  it('la referencia es el folio del comprobante en 20 caracteres', () => {
    expect(referenciaDelComprobante({ tipo: 'ticket', folio: '  1084  58666 ' })).toBe('1084 58666');
    expect(referenciaDelComprobante({ tipo: 'cfdi', folio: 'A'.repeat(30) })).toHaveLength(20);
  });
  it('el comentario arma lo que hoy se teclea: concepto, periodo y unidad', () => {
    expect(comentarioDeLaSolicitud({ concepto: 'Combustible ventas', del: '2026-09-28', al: '2026-10-04', unidad: 'RAM 4000' }))
      .toBe('Combustible ventas DEL 28/09 AL 04/10 RAM 4000');
    expect(comentarioDeLaSolicitud({ concepto: 'Luz', nota: 'Recibo de octubre' })).toBe('Recibo de octubre');
  });
});

describe('[PGP.122] rfcCompatible — el RFC del catálogo de Kepler suele estar mal capturado (ERP_KEPLER §3.z.4)', () => {
  it('igual, con guiones o a ≤ 2 ediciones: compatible', () => {
    expect(rfcCompatible('XAXX010101000', 'XAXX010101000')).toBe(true);
    expect(rfcCompatible('XAXX-010101-000', 'xaxx010101000')).toBe(true);
    expect(rfcCompatible('CCA010101AB1', 'AAA010101AB1')).toBe(true); // dos letras cambiadas (el caso medido, con un RFC de prueba)
  });
  it('un catálogo sin RFC con forma de RFC no contradice nada', () => {
    expect(rfcCompatible('', 'XAXX010101000')).toBe(true);
    expect(rfcCompatible('AAA-010101-B', 'XAXX010101000')).toBe(true);
  });
  it('⛔ NEGATIVA — otro emisor (≥ 3 ediciones) o factura sin RFC: incompatible', () => {
    expect(rfcCompatible('XAXX010101000', 'BBBB990101AB1')).toBe(false);
    expect(rfcCompatible('XAXX010101000', '')).toBe(false);
  });
});

describe('[PGP.122] fechaReal — una fecha imposible es un 400 con su motivo, no un 500', () => {
  it('las que existen en el calendario pasan (bisiesto incluido)', () => {
    for (const d of ['2026-02-28', '2024-02-29', '2026-11-30', '2026-12-31']) expect(fechaReal(d), d).toBe(true);
  });
  it('⛔ NEGATIVA — imposibles o mal escritas', () => {
    for (const d of ['2026-02-30', '2026-11-31', '2026-13-01', '2025-02-29', '26-11-01', '2026-1-01', '', null, undefined]) expect(fechaReal(d), String(d)).toBe(false);
  });
  it('la compuerta la rechaza (bloquea) y el comentario no la escribe en Kepler', () => {
    expect(faltaParaPedir({ ...buena(), comprobante: { tipo: 'ticket', folio: '1', fecha: '2026-02-30' } }).map((x) => x.id)).toContain('fecha_documento');
    expect(comentarioDeLaSolicitud({ concepto: 'Renta', del: '2026-02-30', al: '2026-03-31' })).not.toMatch(/30\/02/);
  });
});

describe('[PGP.122] faltaParaPedir — la compuerta que leen el botón y el 400', () => {
  it('la solicitud completa pasa', () => {
    expect(faltaParaPedir(buena())).toEqual([]);
    expect(puedePedir(buena())).toBe(true);
  });
  it('⛔ NEGATIVA — cada hueco se nombra, uno por uno', () => {
    const casos: Array<[string, Partial<EstadoSolicitudGasto>, string]> = [
      ['sin acreedor', { acreedor: '' }, 'acreedor'],
      ['nómina', { acreedor: 'GN001' }, 'alcance'],
      ['sin renglones', { renglones: [] }, 'renglones'],
      ['renglón sin proyecto', { renglones: [{ concepto: '240', proyecto: '', departamento: '1-02-32-15', importe: 10 }] }, 'renglon'],
      ['proyecto que no cabe', { renglones: [{ concepto: '240', proyecto: '12345678901', departamento: '1-02-32-15', importe: 10 }] }, 'renglon'],
      ['importe con tres decimales', { renglones: [{ concepto: '240', proyecto: 'P', departamento: 'D', importe: 1037.875 }] }, 'importe'],
      ['importe cero', { renglones: [{ concepto: '240', proyecto: 'P', departamento: 'D', importe: 0 }] }, 'importe'],
      ['cuenta de SUA', { renglones: [{ concepto: '047', proyecto: 'P', departamento: 'D', importe: 10, cuenta: '601-015' }] }, 'alcance'],
      ['IVA mayor que el 16 %', { iva: 900 }, 'iva'],
      ['IVA negativo', { iva: -1 }, 'iva'],
      ['sin comprobante', { comprobante: null }, 'comprobante'],
      ['documento futuro', { comprobante: { tipo: 'ticket', folio: '1', fecha: '2026-11-20' } }, 'fecha_documento'],
      ['documento viejo sin motivo', { comprobante: { tipo: 'ticket', folio: '1', fecha: '2026-09-01' } }, 'motivo_fecha'],
      ['sin forma de pago', { forma_pago: '' }, 'forma_pago'],
      ['tarjeta con 19 dígitos', { forma_pago: 'tarjeta', forma_pago_detalle: '4111111111111111111' }, 'forma_pago_detalle'],
      ['sin archivo', { archivos: [] }, 'evidencia'],
    ];
    for (const [nombre, cambio, id] of casos) {
      const f = faltaParaPedir({ ...buena(), ...cambio });
      expect(f.map((x) => x.id), nombre).toContain(id);
    }
  });
  it('un documento viejo CON motivo pasa (no bloquea, pide explicarlo)', () => {
    expect(faltaParaPedir({ ...buena(), comprobante: { tipo: 'ticket', folio: '1', fecha: '2026-09-01' }, motivo_fecha: 'llegó tarde el ticket' })).toEqual([]);
  });
  it('con el CFDI casado al SAT no se pide foto: el documento fiscal es la evidencia', () => {
    const cfdi = { tipo: 'cfdi' as const, folio: 'F-393/7537', fecha: '2026-11-12', uuid: '6F9A1B2C-3D4E-4F50-8A1B-2C3D4E5F6A7B' };
    expect(evidenciaEsElSat(cfdi)).toBe(true);
    expect(faltaParaPedir({ ...buena(), comprobante: cfdi, archivos: [] })).toEqual([]);
  });
  it('⛔ NEGATIVA — una factura SIN uuid casado sí pide su archivo', () => {
    expect(evidenciaEsElSat({ tipo: 'cfdi', folio: 'F-1', fecha: '2026-11-12' })).toBe(false);
    expect(faltaParaPedir({ ...buena(), comprobante: { tipo: 'cfdi', folio: 'F-1', fecha: '2026-11-12' }, archivos: [] }).map((x) => x.id)).toContain('evidencia');
  });
  it('DS17 — al pedir, la referencia de la transferencia y el número de cheque llegan al pagar: no se exigen', () => {
    expect(faltaParaPedir({ ...buena(), forma_pago: 'transferencia', forma_pago_detalle: '' })).toEqual([]);
    expect(faltaParaPedir({ ...buena(), forma_pago: 'cheque', forma_pago_detalle: null })).toEqual([]);
  });
  it('⛔ NEGATIVA DS17 — si se escribe, se valida su forma; y tarjeta u «otro» siguen pidiendo su dato', () => {
    expect(faltaParaPedir({ ...buena(), forma_pago: 'cheque', forma_pago_detalle: 'AB-12' }).map((x) => x.id)).toEqual(['forma_pago_detalle']);
    expect(faltaParaPedir({ ...buena(), forma_pago: 'tarjeta', forma_pago_detalle: '' }).map((x) => x.id)).toEqual(['forma_pago_detalle']);
    expect(faltaParaPedir({ ...buena(), forma_pago: 'otro', forma_pago_detalle: '' }).map((x) => x.id)).toEqual(['forma_pago_detalle']);
  });
  it('una cotización (Pedir antes de gastar) alcanza como archivo', () => {
    expect(faltaParaPedir({ ...buena(), comprobante: { tipo: 'cotizacion', folio: null, fecha: '2026-11-13' }, archivos: [{ role: 'cotizacion_1' }] })).toEqual([]);
  });
});
