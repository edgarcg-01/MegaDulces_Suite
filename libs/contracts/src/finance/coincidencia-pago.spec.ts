import {
  chequeoBanco, chequeoFecha, chequeoMonto, chequeoProveedor, coincidenciasPago, coincidenTodas,
  diferenciasPago, normalizarProveedor, cuentaEsClave, esBancoBajio, formasDeCuenta,
} from './coincidencia-pago.contract';

/**
 * `[PC.5]`/`[PC.6]` — Las cuatro coincidencias exactas comprobante↔pago. Con las cuatro en verde
 * el servidor VALIDA SOLO el comprobante: cada falso «ok» acá es un comprobante validado sin que
 * nadie lo vea. Por eso hay más pruebas del lado «no coincide» que del lado «coincide».
 */
describe('[PC.5] las cuatro comparaciones', () => {
  it('monto: al centavo, sin pelear con el punto flotante', () => {
    expect(chequeoMonto(0.1 + 0.2, 0.3)).toBe('ok');
    expect(chequeoMonto(150621.5, 150621.49)).toBe('difiere');
    expect(chequeoMonto(null, 10)).toBe('sin_dato');
  });

  it('fecha: el mismo día; un día de diferencia ya difiere', () => {
    expect(chequeoFecha('2026-09-29', '2026-09-29T06:00:00.000Z')).toBe('ok');
    expect(chequeoFecha('2026-09-30', '2026-09-29')).toBe('difiere');
    expect(chequeoFecha(null, '2026-09-29')).toBe('sin_dato');
  });

  /** ⚠️ La CLABE termina en dígito verificador: `…01463` + `6`. */
  it('banco: reconoce la cuenta dentro de la CLABE pese al dígito verificador', () => {
    expect(chequeoBanco('002496700783014636', { clave_banco: '1463', account_label: '1463' })).toBe('ok');
  });
  it('banco: número de cuenta o enmascarado', () => {
    expect(chequeoBanco('****1463', { clave_banco: '1463' })).toBe('ok');
    expect(chequeoBanco('0123451463', { account_label: '1463' })).toBe('ok');
  });
  it('banco: otra cuenta propia → difiere', () => {
    expect(chequeoBanco('****4885', { clave_banco: '1463', account_label: '1463' })).toBe('difiere');
  });
  it('⛔ banco: sin cuenta leída, o sin banco en Kepler → sin_dato (nunca ok)', () => {
    expect(chequeoBanco(null, { clave_banco: '1463' })).toBe('sin_dato');
    expect(chequeoBanco('****1463', { clave_banco: null, account_label: null })).toBe('sin_dato');
  });

  it('proveedor: ignora puntuación, acentos y sufijo societario', () => {
    expect(normalizarProveedor('Convermex, S.A. de C.V.')).toBe('CONVERMEX');
    expect(chequeoProveedor('CONVERMEX S.A. DE C.V.', 'CONVERMEX SA DE CV')).toBe('ok');
    expect(chequeoProveedor('DULCERÍA ÁLAMO', 'DULCERIA ALAMO SA DE CV')).toBe('ok');
  });
  it('proveedor: el SPEI trunca el nombre → el truncado cuenta', () => {
    expect(chequeoProveedor('DISTRIBUIDORA DE DULCES Y CHOCOLA', 'DISTRIBUIDORA DE DULCES Y CHOCOLATES DEL BAJIO SA DE CV')).toBe('ok');
  });
  it('⛔ proveedor: nada de parecidos difusos, y un prefijo muy corto no basta', () => {
    expect(chequeoProveedor('DULCES LA ROSITA', 'DULCES DE LA ROSA SA')).toBe('difiere');
    expect(chequeoProveedor('ABC', 'ABC COMERCIAL')).toBe('difiere');
    expect(chequeoProveedor('', 'ABC')).toBe('sin_dato');
  });
});

describe('[PC.6] coincidenciasPago / coincidenTodas / diferenciasPago', () => {
  const pago = { monto: '150621.50', pago_dia: '2026-09-29', proveedor_nombre: 'CONVERMEX SA DE CV', clave_banco: '1463', account_label: '1463' };
  const ocr = { monto: 150621.5, fecha: '2026-09-29', cuenta_origen: '002496700783014636', beneficiario: 'CONVERMEX S.A. DE C.V.' };

  it('las cuatro en verde (el monto de pg llega como texto numeric)', () => {
    const k = coincidenciasPago(ocr, pago);
    expect(k).toEqual({ banco: 'ok', fecha: 'ok', monto: 'ok', proveedor: 'ok' });
    expect(coincidenTodas(k)).toBe(true);
    expect(diferenciasPago(k)).toEqual([]);
  });

  it('⛔ basta una en rojo o sin leer para que NO pasen todas', () => {
    expect(coincidenTodas(coincidenciasPago({ ...ocr, fecha: '2026-09-30' }, pago))).toBe(false);
    expect(coincidenTodas(coincidenciasPago({ ...ocr, beneficiario: null }, pago))).toBe(false);
    expect(diferenciasPago(coincidenciasPago({ ...ocr, cuenta_origen: '****4885', fecha: null }, pago))).toEqual(['banco', 'fecha']);
  });

  it('⛔ sin banco en Kepler nunca pasa', () => {
    expect(coincidenTodas(coincidenciasPago(ocr, { ...pago, clave_banco: null, account_label: null }))).toBe(false);
  });

  it('⛔ sin coincidencias calculadas → no pasa, y faltan las cuatro', () => {
    expect(coincidenTodas(null)).toBe(false);
    expect(diferenciasPago(null)).toEqual(['banco', 'fecha', 'monto', 'proveedor']);
  });

  it('la fecha del pago como Date serializado: manda pago_dia', () => {
    expect(coincidenciasPago(ocr, { ...pago, pago_date: '2026-09-28T06:00:00.000Z' }).fecha).toBe('ok');
  });
});

/**
 * `[PC.7]` BanBajío: la clave de la cuenta va en el CENTRO del número, no al final. Números REALES
 * de los comprobantes de BajioNet del 2026-10-04 (primeras pruebas en producción): todos terminan en
 * `0201`, por eso parecía que todo salía de la misma cuenta.
 */
describe('[PC.7] cuentas BanBajío', () => {
  const pagoBajio = (clave: string) => ({ clave_banco: clave, account_label: clave.slice(-3), banco_nombre: `BAJIO ${clave}` });

  it.each([
    ['245765060201', '6506'], // SPEI a EMBOTELLADORA AGA DEL CENTRO
    ['245758540201', '5854'], // traspaso entre cuentas propias, origen
    ['199241660201', '4166'], // traspaso entre cuentas propias, destino
  ])('%s es la cuenta Kepler BAJIO %s', (cuenta, clave) => {
    expect(chequeoBanco(cuenta, pagoBajio(clave))).toBe('ok');
    expect(cuentaEsClave(cuenta, clave, 'BBAJIO')).toBe(true);
  });

  /** ⛔ No es relajar: otra cuenta del MISMO banco sigue sin coincidir. */
  it.each([
    ['245765060201', '5854'],
    ['245765060201', '3660'],
    ['245758540201', '6506'],
    ['199241660201', '4166'.replace('4166', '3660')],
  ])('⛔ %s NO es la cuenta BAJIO %s', (cuenta, clave) => {
    expect(chequeoBanco(cuenta, pagoBajio(clave))).toBe('difiere');
  });

  it('⛔ el sufijo común 0201 NO identifica una cuenta', () => {
    expect(chequeoBanco('245765060201', pagoBajio('0201'))).toBe('difiere');
  });

  it('⛔ con la clave de Kepler, la etiqueta corta de Bancos no basta (506 vs 6506)', () => {
    // una cuenta hipotética 2457 1506 0201: termina en «506» pero su clave sería 1506
    expect(chequeoBanco('245715060201', { clave_banco: '6506', account_label: '506', banco_nombre: 'BAJIO 6506' })).toBe('difiere');
  });

  it('sin clave de Kepler se usa la etiqueta de Bancos de respaldo', () => {
    expect(chequeoBanco('245765060201', { clave_banco: null, account_label: '506', banco_nombre: 'BAJIO' })).toBe('ok');
  });

  it('⛔ en OTRO banco, un número de 12 dígitos se lee por el final (no por el centro)', () => {
    expect(chequeoBanco('245765060201', { clave_banco: '6506', banco_nombre: 'BBVA 6506' })).toBe('difiere');
    expect(formasDeCuenta('245765060201', 'BBVA')).toEqual(['245765060201']);
  });

  it('formasDeCuenta: Bajío se lee SÓLO sin los 4 últimos; CLABE también sin el verificador', () => {
    expect(formasDeCuenta('245765060201', 'BAJIO 6506')).toEqual(['24576506']);
    expect(formasDeCuenta('002496700783014636')).toEqual(['002496700783014636', '00249670078301463']);
    expect(esBancoBajio('BBAJIO')).toBe(true);
    expect(esBancoBajio('BanBajío')).toBe(true);
    expect(esBancoBajio('BANAMEX')).toBe(false);
  });

  it('las cuatro coincidencias con el SPEI real de BajioNet', () => {
    const k = coincidenciasPago(
      { monto: 9970.01, fecha: '2026-09-01', cuenta_origen: '245765060201', beneficiario: 'EMBOTELLADORA AGA DEL CENTRO' },
      { monto: '9970.01', pago_dia: '2026-09-01', proveedor_nombre: 'EMBOTELLADORA AGA DEL CENTRO SA DE CV', clave_banco: '6506', account_label: '506', banco_nombre: 'BAJIO 6506' },
    );
    expect(k).toEqual({ banco: 'ok', fecha: 'ok', monto: 'ok', proveedor: 'ok' });
  });
});
