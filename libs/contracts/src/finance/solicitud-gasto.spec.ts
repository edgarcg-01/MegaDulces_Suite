import {
  alcanceDelAcreedor, avisoDeFechas, comentarioDeLaSolicitud, cuentaFueraDeAlcance, evidenciaEsElSat, faltaParaPedir, fechaReal, rfcCompatible,
  lineaAmpara, puedePedir, referenciaDelComprobante, totalesDeLaSolicitud, type EstadoSolicitudGasto,
  basesDeQuienPide, correoValido, cuentaDePago, fechaDePago, hayInformacionDePago, PLAZOS_DE_PAGO,
  conceptoDistintoDeCedis, rubroDeCuenta, lecturaParaGuardar, fechaLeidaProponible, conceptoSinCuenta, motivoParaNoOfrecer,
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

describe('[PGP.122] R14 conceptoDistintoDeCedis — la cuenta del concepto aquí contra la de CEDIS', () => {
  const capitan = { codigo: '074', nombre: 'CAPITAN DE MARCA.', cuenta: '102' };
  const capitanCedis = { nombre: 'CAPITAN DE MARCA.', cuenta: '606-014' };
  it('el caso medido: el 074 va a 102 (caja) en 01 y a 606-014 (gasto) en 00 → bloquea, y dice cuentas y quién lo corrige', () => {
    const m = conceptoDistintoDeCedis(capitan, capitanCedis, '01');
    expect(m).toMatch(/CAPITAN DE MARCA \(074\)/);
    expect(m).toMatch(/102/);
    expect(m).toMatch(/606-014/);
    expect(m).toMatch(/Contabilidad/);
  });
  it('el nombre se compara sin punto final, espacios ni mayúsculas: sigue siendo el mismo concepto', () => {
    expect(conceptoDistintoDeCedis({ ...capitan, nombre: ' capitan  de marca ' }, capitanCedis, '06')).toMatch(/Contabilidad/);
  });
  it('el mismo rubro con otra subcuenta (la caja propia de La Piedad) entra', () => {
    expect(conceptoDistintoDeCedis({ codigo: '012', nombre: 'CAJA GENERAL LPA.', cuenta: '102-0142' }, { nombre: 'CAJA GENERAL LPA.', cuenta: '102-0042' }, '02')).toBeNull();
    expect(conceptoDistintoDeCedis({ codigo: '240', nombre: 'X', cuenta: '602-008' }, { nombre: 'X', cuenta: '602-008' }, '08')).toBeNull();
  });
  it('el mismo código con OTRO nombre es otro concepto (el 246: «Traspaso salida» en 00, «Degustación» en 02) → entra', () => {
    expect(conceptoDistintoDeCedis({ codigo: '246', nombre: 'DEGUSTACION A CLIENTES', cuenta: '606-006' }, { nombre: 'TRASPASO SALIDA', cuenta: '515-002' }, '02')).toBeNull();
  });
  it('sin contra qué comparar entra: CEDIS mismo, CEDIS sin el concepto o sin cuenta, o el concepto sin cuenta aquí', () => {
    expect(conceptoDistintoDeCedis(capitan, capitanCedis, '00')).toBeNull();
    expect(conceptoDistintoDeCedis(capitan, null, '01')).toBeNull();
    expect(conceptoDistintoDeCedis(capitan, { nombre: 'CAPITAN DE MARCA.', cuenta: '  ' }, '01')).toBeNull();
    expect(conceptoDistintoDeCedis({ codigo: '512', nombre: 'PAPEL HIGIENICO.', cuenta: '' }, { nombre: 'PAPEL HIGIENICO.', cuenta: '608-008' }, '08')).toBeNull();
  });
  it('rubroDeCuenta: lo anterior al primer guion', () => {
    expect(rubroDeCuenta('606-014')).toBe('606');
    expect(rubroDeCuenta(' 102-0142 ')).toBe('102');
    expect(rubroDeCuenta('102')).toBe('102');
    expect(rubroDeCuenta(null)).toBe('');
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

// ── S.17 (Francisco, 2026-11-16): base, plazo e información de pago ─────────────────────────────


/** Una CLABE con su dígito de control bien (calculado con la regla de Banxico) y la misma con el último dígito mal. */
const CLABE_BUENA = '012180001234567899';
const CLABE_MALA = '012180001234567890';
const ABIERTAS = ['05', '07', '08', '00', '07'];

describe('[PGP.122] S.17 basesDeQuienPide — DS27: la base sale de los almacenes de quien pide', () => {
  it('con todas: las abiertas, ordenadas y sin repetir', () => {
    expect(basesDeQuienPide(ABIERTAS, { modo: 'all', valores: [], resoluble: true })).toEqual({ bases: ['00', '05', '07', '08'], alcance: 'todas' });
  });
  it('con varias: sólo las suyas que estén abiertas (el cajero de 07 y 08)', () => {
    expect(basesDeQuienPide(ABIERTAS, { modo: 'listed', valores: ['07', '08', '03'], resoluble: true })).toEqual({ bases: ['07', '08'], alcance: 'varias' });
  });
  it('con una: esa, fija (se dice «una» aunque no esté abierta: la pantalla explica que no se ha abierto)', () => {
    expect(basesDeQuienPide(ABIERTAS, { modo: 'own', valores: ['05'], resoluble: true })).toEqual({ bases: ['05'], alcance: 'una' });
    expect(basesDeQuienPide(ABIERTAS, { modo: 'own', valores: ['03'], resoluble: true })).toEqual({ bases: [], alcance: 'una' });
  });
  it('⛔ NEGATIVA — sin almacén en su ficha o sin alcance: ninguna, NUNCA las nueve (sería pedir de más)', () => {
    expect(basesDeQuienPide(ABIERTAS, { modo: 'own', valores: [], resoluble: false })).toEqual({ bases: [], alcance: 'sin_almacen' });
    expect(basesDeQuienPide(ABIERTAS, { modo: 'listed', valores: [], resoluble: true })).toEqual({ bases: [], alcance: 'sin_almacen' });
    expect(basesDeQuienPide(ABIERTAS, { modo: 'none', valores: [], resoluble: true })).toEqual({ bases: [], alcance: 'ninguna' });
    expect(basesDeQuienPide(ABIERTAS, null)).toEqual({ bases: [], alcance: 'ninguna' });
  });
});

describe('[PGP.122] S.17 fechaDePago — DS30: el plazo vuelve fecha de pago (c18)', () => {
  const hoy = '2026-11-16';
  it('los plazos a un toque empiezan de contado', () => {
    expect(PLAZOS_DE_PAGO[0]).toBe(0);
  });
  it('de contado es hoy, aunque la factura sea vieja (no se dice «venció»)', () => {
    expect(fechaDePago({ dias: 0, desde: '2026-10-02', hoy })).toEqual({ fecha: hoy, vencio: null, desde: 'hoy' });
  });
  it('con días, desde la fecha de la factura; sin documento, desde hoy', () => {
    expect(fechaDePago({ dias: 30, desde: '2026-11-10', hoy })).toEqual({ fecha: '2026-12-10', vencio: null, desde: 'documento' });
    expect(fechaDePago({ dias: 15, desde: null, hoy })).toEqual({ fecha: '2026-12-01', vencio: null, desde: 'hoy' });
  });
  it('⛔ NEGATIVA — ya vencido: se pide para hoy y se dice cuándo venció (el servidor descarta una fecha pasada)', () => {
    expect(fechaDePago({ dias: 7, desde: '2026-10-20', hoy })).toEqual({ fecha: hoy, vencio: '2026-10-27', desde: 'documento' });
  });
  it('⛔ NEGATIVA — un plazo absurdo se acota (0 a 120) y una fecha imposible cuenta desde hoy', () => {
    expect(fechaDePago({ dias: -5, desde: '2026-11-10', hoy }).fecha).toBe(hoy);
    expect(fechaDePago({ dias: 9999, desde: null, hoy }).fecha).toBe('2027-03-16');
    expect(fechaDePago({ dias: 7, desde: '2026-02-30', hoy })).toEqual({ fecha: '2026-11-23', vencio: null, desde: 'hoy' });
  });
});

describe('[PGP.122] S.17 cuentaDePago y correoValido — DS31: lo que va al banco tiene forma', () => {
  it('la CLABE con su dígito de control, con espacios o guiones al teclearla', () => {
    expect(cuentaDePago('0121 8000 1234 5678 99')).toEqual({ ok: true, cuenta: CLABE_BUENA, tipo: 'clabe' });
    expect(cuentaDePago('4152-3134-0000-1234')).toEqual({ ok: true, cuenta: '4152313400001234', tipo: 'tarjeta' });
    expect(cuentaDePago('12345678901234')).toEqual({ ok: true, cuenta: '12345678901234', tipo: 'cuenta' });
    expect(cuentaDePago('   ')).toBeNull();
  });
  it('⛔ NEGATIVA — el error de dedo en la CLABE, letras o un largo que no es cuenta', () => {
    expect(cuentaDePago(CLABE_MALA)).toMatchObject({ ok: false });
    expect(cuentaDePago('BBVA 0121800012')).toMatchObject({ ok: false });
    expect(cuentaDePago('123456789')).toMatchObject({ ok: false });
    expect(cuentaDePago('12345678901234567890')).toMatchObject({ ok: false });
  });
  it('el correo: una sola dirección con su dominio', () => {
    expect(correoValido('pagos@proveedor.com.mx')).toBe(true);
    for (const malo of ['pagos@proveedor', 'pagosproveedor.com', 'a@b.c', 'uno@a.com, dos@b.com', 'con espacio@a.com', '']) expect(correoValido(malo)).toBe(false);
  });
  it('la compuerta: vacía no estorba; mal escrita bloquea y dice qué corregir', () => {
    expect(faltaParaPedir({ ...buena(), pago: { cuenta: '', banco: '', correo: '' } })).toEqual([]);
    expect(faltaParaPedir({ ...buena(), pago: { cuenta: CLABE_BUENA, banco: 'BBVA', correo: 'pagos@proveedor.com.mx' } })).toEqual([]);
    expect(hayInformacionDePago({ cuenta: ' ', correo: null })).toBe(false);
    expect(hayInformacionDePago({ correo: 'pagos@proveedor.com.mx' })).toBe(true);
  });
  it('⛔ NEGATIVA — la compuerta nombra cada dato mal escrito', () => {
    const ids = faltaParaPedir({ ...buena(), pago: { cuenta: CLABE_MALA, banco: 'X'.repeat(41), correo: 'pagos@' } }).map((x) => x.id);
    expect(ids).toEqual(['pago_cuenta', 'pago_banco', 'pago_correo']);
  });
});

/**
 * `[PGP.122.13]` Lo que propuso el lector se guarda con la solicitud (`capture_meta.lectura`) para MEDIR cuánto corrige la
 * gente la fecha leída: sin eso, el 2026-11-21 sólo se sabía que la fuente final era «persona» en 8 de 9 solicitudes.
 * Nunca decide nada; lo que llega de la pantalla se limpia antes de guardarse.
 */
describe('[PGP.122.13] lecturaParaGuardar', () => {
  it('guarda los cuatro datos de la lectura, tal cual', () => {
    expect(lecturaParaGuardar({ fecha: '2026-11-21', fecha_impresa: '21/11/26', total: 3000, folio: '102933', subtotal: 1, rfc: 'X' }))
      .toEqual({ fecha: '2026-11-21', fecha_impresa: '21/11/26', total: 3000, folio: '102933' });
  });
  it('⛔ limpia lo que no es: fecha sin forma ISO, total no numérico, textos largos o vacíos', () => {
    expect(lecturaParaGuardar({ fecha: '21/11/2026', fecha_impresa: 'x'.repeat(60), total: 'mucho', folio: '  ' }))
      .toEqual({ fecha: null, fecha_impresa: 'x'.repeat(40), total: null, folio: null });
    expect(lecturaParaGuardar({ total: Number.NaN })).toBeNull();
  });
  it('sin lectura (ilegible, o un servidor anterior) no se guarda nada', () => {
    expect(lecturaParaGuardar(null)).toBeNull();
    expect(lecturaParaGuardar(undefined)).toBeNull();
    expect(lecturaParaGuardar('2026-11-21')).toBeNull();
    expect(lecturaParaGuardar({ fecha: null, fecha_impresa: null, total: null, folio: null })).toBeNull();
  });
  it('el total en cero sí es una lectura (no se confunde con «nada leído»)', () => {
    expect(lecturaParaGuardar({ total: 0 })).toEqual({ fecha: null, fecha_impresa: null, total: 0, folio: null });
  });
});

/**
 * `[PGP.122.13]` Las dos primeras usuarias (2026-11-21) recibieron una fecha propuesta con el AÑO mal. La lectura sólo se
 * propone si cae en los últimos 30 días: un año mal leído queda a 365 días o más y nunca llega a la pantalla.
 */
describe('[PGP.122.13] fechaLeidaProponible — la fecha leída sólo se propone si es de los últimos 30 días', () => {
  const hoy = '2026-11-21';
  it('hoy y hasta 30 días atrás, sí', () => {
    expect(fechaLeidaProponible('2026-11-21', hoy)).toBe('2026-11-21');
    expect(fechaLeidaProponible('2026-11-11', hoy)).toBe('2026-11-11');
    expect(fechaLeidaProponible('2026-10-22', hoy)).toBe('2026-10-22');
  });
  it('⭐ el AÑO mal leído no se propone: el anterior, uno lejano («21/11/26» leído AÑO/MES/DÍA) ni el siguiente', () => {
    expect(fechaLeidaProponible('2025-11-21', hoy)).toBeNull();
    expect(fechaLeidaProponible('2021-11-26', hoy)).toBeNull();
    expect(fechaLeidaProponible('2027-11-21', hoy)).toBeNull();
  });
  it('a 31 días, o de mañana, no', () => {
    expect(fechaLeidaProponible('2026-10-21', hoy)).toBeNull();
    expect(fechaLeidaProponible('2026-11-22', hoy)).toBeNull();
  });
  it('el cambio de año no estorba: el ticket del 30 de diciembre leído el 3 de enero sí se propone', () => {
    expect(fechaLeidaProponible('2025-12-30', '2026-01-03')).toBe('2025-12-30');
  });
  it('sin fecha, sin forma ISO o con un día que no existe: null', () => {
    expect(fechaLeidaProponible(null, hoy)).toBeNull();
    expect(fechaLeidaProponible('', hoy)).toBeNull();
    expect(fechaLeidaProponible('21/11/2026', hoy)).toBeNull();
    expect(fechaLeidaProponible('2026-02-31', hoy)).toBeNull();
    expect(fechaLeidaProponible('2026-11-20', 'hoy')).toBeNull();
  });
});

/**
 * `[PGP.122.14]` Lo que «Pedir un gasto» no ofrece se DICE, no se esconde: el 2026-11-21 se buscó el 364 «PC VERIFICADOR DE
 * PRECIO» y no salía nada. El catálogo trae todo y cada concepto que no se puede pedir viene con su motivo.
 */
describe('[PGP.122.14] lo que no se ofrece se dice, con su motivo', () => {
  it('conceptoSinCuenta: sin cuenta en el catálogo de ese servidor, el motivo; con cuenta, null', () => {
    expect(conceptoSinCuenta('', '01')).toBe('Le falta la cuenta contable en el catálogo de Kepler de 01: se podrá pedir cuando Contabilidad la ponga');
    expect(conceptoSinCuenta('  ', '01')).toMatch(/Kepler de 01/);
    expect(conceptoSinCuenta(null, '06')).toMatch(/Kepler de 06/);
    expect(conceptoSinCuenta('601-002', '01')).toBeNull();
  });
  it('el 364 «PC VERIFICADOR DE PRECIO» va a 150-002: activo fijo, fuera de v1 por DS3, con su motivo', () => {
    expect(cuentaFueraDeAlcance('150-002')).toBe('La cuenta 150-002 es de activo fijo, no de gasto: ese renglón se captura en Kepler');
  });
  it('motivoParaNoOfrecer: el de alcance (o sin cuenta) primero, después R14; null si se ofrece', () => {
    expect(motivoParaNoOfrecer({ fuera_de_alcance: 'A', distinto_de_cedis: 'B' })).toBe('A');
    expect(motivoParaNoOfrecer({ fuera_de_alcance: null, distinto_de_cedis: 'B' })).toBe('B');
    expect(motivoParaNoOfrecer({ fuera_de_alcance: null })).toBeNull();
    expect(motivoParaNoOfrecer({ fuera_de_alcance: '', distinto_de_cedis: '' })).toBeNull();
  });
});
