import {
  detieneElPago, diaDelCfdi, motivoQueDetiene, normaDelPago, normaFiscalDelCfdi, puedeRegistrar, textoDelFreno,
  type CfdiParaNorma, type EntradaNorma,
} from './norma-fiscal-cfdi.contract';
import type { CfdiRecibido } from './cfdi-factura.contract';

// Una recibida en regla: tipo I vigente, PPD, G03, a nuestro nombre con 612.
const cfdi = (o: Partial<CfdiParaNorma> = {}): CfdiParaNorma => ({
  uuid: 'U1', rol: 'recibidas', fecha: '2026-10-28', estatus_sat: 'vigente', metodo_pago: 'PPD', forma_pago: '99',
  receptor_uso_cfdi: 'G03', receptor_regimen: '612', emisor_regimen: '601', emisor_rfc: 'GAM010101AB1', ...o,
});
const pue = (o: Partial<CfdiParaNorma> = {}) => cfdi({ metodo_pago: 'PUE', forma_pago: '03', ...o });
const e = (c: CfdiParaNorma, o: Partial<EntradaNorma> = {}): EntradaNorma => ({ cfdi: c, uso: 'pago', fecha_operacion: '2026-10-30', hoy: '2026-10-29', ...o });
const v = (c: CfdiParaNorma, o: Partial<EntradaNorma> = {}) => normaFiscalDelCfdi(e(c, o)).veredicto;
const reglas = (c: CfdiParaNorma, o: Partial<EntradaNorma> = {}) => normaFiscalDelCfdi(e(c, o)).motivos.map((m) => `${m.regla}:${m.veredicto}`);

describe('[PGP.223] la norma fiscal del CFDI', () => {
  it('⭐ una recibida en regla es apta para pagar, comprar y gastar, sin ningún motivo', () => {
    for (const uso of ['pago', 'compra', 'gasto'] as const) {
      expect(normaFiscalDelCfdi(e(cfdi(), { uso }))).toEqual({ veredicto: 'apta', motivos: [] });
    }
    expect(puedeRegistrar(normaFiscalDelCfdi(e(cfdi())))).toBe(true);
    expect(motivoQueDetiene(normaFiscalDelCfdi(e(cfdi())))).toBeNull();
  });

  describe('N0 · cancelada', () => {
    it('⛔ cancelada: sólo informativa para los cuatro usos, sin importar mayúsculas', () => {
      for (const uso of ['pago', 'compra', 'gasto'] as const) expect(v(cfdi({ estatus_sat: 'cancelado' }), { uso })).toBe('solo_informativa');
      expect(v(cfdi({ estatus_sat: 'Cancelado' }))).toBe('solo_informativa');   // el error de ajuste-abono
      expect(v(cfdi({ estatus_sat: 'Cancelada' }))).toBe('solo_informativa');
      expect(v(cfdi({ rol: 'emitidas', emisor_regimen: '612', estatus_sat: 'cancelado' }), { uso: 'venta' })).toBe('solo_informativa');
    });
    it('una cancelada no se reporta además como «sin verificar»', () => {
      expect(reglas(cfdi({ estatus_sat: 'cancelado' }))).toEqual(['cancelada:solo_informativa']);
    });
  });

  describe('el rol', () => {
    it('⛔ una emitida no ampara un pago, una compra ni un gasto; una recibida no es venta', () => {
      const emitida = cfdi({ rol: 'emitidas', emisor_regimen: '612' });
      for (const uso of ['pago', 'compra', 'gasto'] as const) expect(v(emitida, { uso })).toBe('solo_informativa');
      expect(v(cfdi(), { uso: 'venta' })).toBe('solo_informativa');
      expect(normaFiscalDelCfdi(e(cfdi(), { uso: 'venta' })).motivos[0].texto).toBe('Es una factura recibida: no es venta');
    });
    it('una emitida en regla sí es venta', () => {
      expect(v(cfdi({ rol: 'emitidas', emisor_regimen: '612' }), { uso: 'venta' })).toBe('apta');
    });
  });

  describe('N1 · PUE de un mes anterior (candado al pagar)', () => {
    it('⭐ frontera de mes: del 31-oct pagada el 31-oct pasa; pagada el 1-nov no', () => {
      const c = pue({ fecha: '2026-10-31' });
      expect(v(c, { fecha_operacion: '2026-10-31', hoy: '2026-10-31' })).toBe('apta');
      expect(v(c, { fecha_operacion: '2026-11-01', hoy: '2026-10-31' })).toBe('solo_informativa');
    });
    it('⛔ dentro de su mes pasa, aunque sea días después de la factura (el límite es el fin de mes, no su fecha)', () => {
      expect(v(pue({ fecha: '2026-10-03' }), { fecha_operacion: '2026-10-30', hoy: '2026-10-29' })).toBe('apta');
    });
    it('⛔ se mide contra el día en que SALE el dinero: programada en octubre y autorizada en noviembre ya no pasa', () => {
      expect(v(pue(), { fecha_operacion: '2026-10-30', hoy: '2026-11-02' })).toBe('solo_informativa');
    });
    it('programada para el mes siguiente, aunque hoy siga en su mes: no pasa', () => {
      const n = normaFiscalDelCfdi(e(pue(), { fecha_operacion: '2026-11-02', hoy: '2026-10-29' }));
      expect(n.veredicto).toBe('solo_informativa');
      expect(n.motivos[0].texto).toBe('PUE del 28-oct: su mes cerró el 31-oct y el pago sale el 2-nov. No se paga: pide al proveedor que la sustituya por PPD');
    });
    it('⛔ con tarjeta, efectivo u otra forma la PUE ya se pagó: sin freno', () => {
      for (const forma of ['01', '04', '28', '99']) {
        expect(v(pue({ forma_pago: forma }), { fecha_operacion: '2026-12-15', hoy: '2026-12-15' })).toBe('apta');
      }
      expect(v(pue({ forma_pago: '02' }), { fecha_operacion: '2026-12-15', hoy: '2026-12-15' })).toBe('solo_informativa');
    });
    it('⛔ PPD no tiene mes: sin freno', () => {
      expect(v(cfdi(), { fecha_operacion: '2027-03-01', hoy: '2027-03-01' })).toBe('apta');
    });
    it('⛔ el freno es al pago: la misma PUE se registra como compra o gasto', () => {
      for (const uso of ['compra', 'gasto'] as const) expect(v(pue(), { uso, fecha_operacion: '2026-12-15', hoy: '2026-12-15' })).toBe('apta');
    });
    it('el método y la forma se leen sin espacios ni mayúsculas', () => {
      expect(v(pue({ metodo_pago: ' pue ', forma_pago: ' 03 ' }), { fecha_operacion: '2026-11-02' })).toBe('solo_informativa');
    });
    it('una PUE cuya fecha no se pudo leer se declara: sin medir, no apta', () => {
      expect(reglas(pue({ fecha: null }))).toEqual(['pue_mes_anterior:sin_medir']);
    });
  });

  describe('la fecha del CFDI es día de México', () => {
    it('⭐ un timestamptz de las 23:30 del 31-oct en México (1-nov en UTC) es octubre', () => {
      const instante = new Date('2026-11-01T05:30:00Z');
      expect(diaDelCfdi(instante)).toBe('2026-10-31');
      expect(diaDelCfdi('2026-11-01T05:30:00.000Z')).toBe('2026-10-31');
      expect(v(pue({ fecha: instante }), { fecha_operacion: '2026-11-02', hoy: '2026-11-02' })).toBe('solo_informativa');
    });
    it('un texto sin zona es hora de México; una fecha sola es ese día', () => {
      expect(diaDelCfdi('2026-10-31T23:30:00')).toBe('2026-10-31');
      expect(diaDelCfdi('2026-10-31')).toBe('2026-10-31');
      expect(diaDelCfdi('2026-10-31T23:30:00-06:00')).toBe('2026-10-31');
      expect(diaDelCfdi('no es fecha')).toBeNull();
      expect(diaDelCfdi(null)).toBeNull();
    });
  });

  describe('N2 · sin efectos fiscales (S01)', () => {
    it('⛔ S01 recibida pide autorización para pagar, comprar y gastar', () => {
      for (const uso of ['pago', 'compra', 'gasto'] as const) expect(v(cfdi({ receptor_uso_cfdi: 'S01' }), { uso })).toBe('requiere_autorizacion');
    });
    it('autorizada pasa (y dice quién); negada queda sólo informativa (y dice quién)', () => {
      const s01 = cfdi({ receptor_uso_cfdi: 'S01' });
      const si = normaFiscalDelCfdi(e(s01, { autorizaciones: [{ regla: 'sin_efectos_fiscales', decision: 'se_usa', por: 'mgarcia' }] }));
      expect(si.veredicto).toBe('apta');
      expect(si.motivos[0].texto).toBe('Uso S01 (sin efectos fiscales): autorizada por mgarcia (Administración o Contabilidad)');
      const no = normaFiscalDelCfdi(e(s01, { autorizaciones: [{ regla: 'sin_efectos_fiscales', decision: 'no_se_usa', por: 'mgarcia' }] }));
      expect(no.veredicto).toBe('solo_informativa');
      expect(no.motivos[0].texto).toBe('Uso S01 (sin efectos fiscales): mgarcia decidió que no se usa');
    });
    it('sin saber quién, lo dice por el área', () => {
      const n = normaFiscalDelCfdi(e(cfdi({ receptor_uso_cfdi: 'S01' }), { autorizaciones: [{ regla: 'sin_efectos_fiscales', decision: 'no_se_usa' }] }));
      expect(n.motivos[0].texto).toBe('Uso S01 (sin efectos fiscales): Administración o Contabilidad decidió que no se usa');
      expect(normaFiscalDelCfdi(e(cfdi({ receptor_uso_cfdi: 'S01' }))).motivos[0].texto)
        .toBe('Uso S01 (sin efectos fiscales): necesita la autorización de Administración o Contabilidad');
    });
    it('⛔ una autorización de OTRA regla no la cubre', () => {
      expect(v(cfdi({ receptor_uso_cfdi: 'S01' }), { autorizaciones: [{ regla: 'regimen', decision: 'se_usa' }] })).toBe('requiere_autorizacion');
    });
    it('en venta, S01 es la factura global: apta', () => {
      expect(v(cfdi({ rol: 'emitidas', emisor_regimen: '612', receptor_uso_cfdi: 'S01' }), { uso: 'venta' })).toBe('apta');
    });
    it('⭐ la comisión que el banco cobra solo no pide autorización, y se dice (D-NF4)', () => {
      const bbva = normaFiscalDelCfdi(e(cfdi({ receptor_uso_cfdi: 'S01', emisor_rfc: ' bba830831lj2 ', metodo_pago: 'PUE', forma_pago: '03' })));
      expect(bbva).toEqual({ veredicto: 'apta', motivos: [{ regla: 'sin_efectos_fiscales', veredicto: 'apta', texto: 'Uso S01 de BBVA: el banco la cobra solo, no pide autorización' }] });
      expect(v(cfdi({ receptor_uso_cfdi: 'S01', emisor_rfc: 'BMN930209927' }), { uso: 'gasto' })).toBe('apta');
    });
    it('⛔ la excepción del banco es sólo de la S01: cancelada sigue sin servir', () => {
      expect(v(cfdi({ receptor_uso_cfdi: 'S01', emisor_rfc: 'BBA830831LJ2', estatus_sat: 'cancelado' }))).toBe('solo_informativa');
    });
    it('⛔ un traslado (tipo T) lleva S01 por regla del SAT: no pide autorización', () => {
      expect(reglas(cfdi({ receptor_uso_cfdi: 'S01', tipo_comprobante: ' t ' }))).toEqual([]);
      expect(v(cfdi({ receptor_uso_cfdi: 'S01', tipo_comprobante: 'I' }))).toBe('requiere_autorizacion');   // control
      expect(v(cfdi({ receptor_uso_cfdi: 'S01', tipo_comprobante: null }))).toBe('requiere_autorizacion');  // no se sabe: aplica
    });
  });

  describe('N3 · régimen 612', () => {
    it('⛔ recibida con otro régimen a nuestro nombre pide autorización', () => {
      expect(v(cfdi({ receptor_regimen: '606' }))).toBe('requiere_autorizacion');
      expect(v(cfdi({ receptor_regimen: '606' }), { autorizaciones: [{ regla: 'regimen', decision: 'se_usa' }] })).toBe('apta');
    });
    it('⭐ el IMSS es excepción por regla: pasa sin autorización, y se dice', () => {
      const imss = normaFiscalDelCfdi(e(cfdi({ receptor_regimen: '606', emisor_rfc: ' ims421231i45 ' })));
      expect(imss.veredicto).toBe('apta');
      expect(imss.motivos).toEqual([{ regla: 'regimen', veredicto: 'apta', texto: 'Régimen 606: el IMSS es excepción por regla' }]);
    });
    it('⛔ la excepción del IMSS es sólo del régimen: un IMSS cancelado sigue sin servir', () => {
      expect(v(cfdi({ receptor_regimen: '606', emisor_rfc: 'IMS421231I45', estatus_sat: 'cancelado' }))).toBe('solo_informativa');
    });
    it('⛔ emitida con otro régimen no es venta (las rentas con 606)', () => {
      const renta = normaFiscalDelCfdi(e(cfdi({ rol: 'emitidas', emisor_regimen: '606' }), { uso: 'venta' }));
      expect(renta.veredicto).toBe('solo_informativa');
      expect(renta.motivos[0].texto).toBe('Emitida con régimen 606, no 612: no es venta de la distribuidora');
    });
    it('⛔ S01 y otro régimen: autorizar sólo la S01 no basta; cada regla lleva su decisión', () => {
      const ambas = cfdi({ receptor_uso_cfdi: 'S01', receptor_regimen: '606' });
      const s01 = { regla: 'sin_efectos_fiscales', decision: 'se_usa' } as const;
      expect(v(ambas, { autorizaciones: [s01] })).toBe('requiere_autorizacion');
      expect(v(ambas, { autorizaciones: [s01, { regla: 'regimen', decision: 'se_usa' }] })).toBe('apta');
      expect(v(ambas, { autorizaciones: [s01, { regla: 'regimen', decision: 'no_se_usa' }] })).toBe('solo_informativa');
    });
    it('sin régimen se declara, no se da por 612', () => {
      expect(reglas(cfdi({ receptor_regimen: '' }))).toEqual(['regimen:sin_medir']);
    });
  });

  describe('N4 · sin verificar en el SAT', () => {
    it('⛔ no se paga hasta que el SAT la verifique', () => {
      expect(v(cfdi({ estatus_sat: 'desconocido' }))).toBe('sin_medir');
      expect(v(cfdi({ estatus_sat: null }))).toBe('sin_medir');
    });
    it('para registrar una compra, un gasto o una venta sólo avisa', () => {
      for (const uso of ['compra', 'gasto'] as const) {
        expect(reglas(cfdi({ estatus_sat: 'desconocido' }), { uso })).toEqual(['sin_verificar:apta']);
      }
      expect(v(cfdi({ rol: 'emitidas', emisor_regimen: '612', estatus_sat: 'desconocido' }), { uso: 'venta' })).toBe('apta');
    });
  });

  it('⭐ el veredicto es el más severo y los motivos van del más severo al aviso', () => {
    const n = normaFiscalDelCfdi(e(pue({ estatus_sat: 'desconocido', receptor_uso_cfdi: 'S01' }), { fecha_operacion: '2026-11-02' }));
    expect(n.motivos.map((m) => m.veredicto)).toEqual(['solo_informativa', 'requiere_autorizacion', 'sin_medir']);
    expect(n.veredicto).toBe('solo_informativa');
    expect(motivoQueDetiene(n)?.regla).toBe('pue_mes_anterior');
    expect(puedeRegistrar(n)).toBe(false);
  });
});

describe('[PGP.225] el freno en Pagos', () => {
  // Como llega de la consulta del Calendario (`SQL_CFDIS_CANDIDATOS`): fecha ya en día de México.
  const rec = (o: Partial<CfdiRecibido> = {}): CfdiRecibido => ({
    uuid: 'a1b2c3d4-0000-0000-0000-000000000001', emisor_rfc: 'GAM010101AB1', total: 11600, fecha: '2026-10-28', metodo_pago: 'PUE', forma_pago: '03',
    iva: 1600, ieps: null, retenido: null, estatus_sat: 'vigente', receptor_uso_cfdi: 'G01', receptor_regimen: '612', emisor_regimen: '601', ...o,
  });
  const detiene = (c: CfdiRecibido, momento: 'programar' | 'autorizar', fecha = '2026-10-30', hoy = '2026-10-29') =>
    detieneElPago(normaDelPago(c, fecha, hoy), momento)?.regla ?? null;

  it('⭐ PUE de mes anterior: se detiene al programar y al autorizar', () => {
    expect(detiene(rec(), 'programar', '2026-11-02')).toBe('pue_mes_anterior');
    expect(detiene(rec(), 'autorizar', '2026-10-30', '2026-11-03')).toBe('pue_mes_anterior');
    expect(detiene(rec(), 'autorizar')).toBeNull();   // control: dentro de su mes pasa
  });
  it('⛔ la cancelada se detiene siempre', () => {
    expect(detiene(rec({ estatus_sat: 'cancelado', metodo_pago: 'PPD', forma_pago: '99' }), 'programar')).toBe('cancelada');
  });
  it('⭐ sin verificar: se programa, pero no se autoriza (D-NF5)', () => {
    const c = rec({ estatus_sat: 'desconocido', metodo_pago: 'PPD', forma_pago: '99' });
    expect(detiene(c, 'programar')).toBeNull();
    expect(detiene(c, 'autorizar')).toBe('sin_verificar');
  });
  it('⛔ si la consulta no trajo el estatus, no se da por verificada', () => {
    expect(detiene(rec({ estatus_sat: undefined, metodo_pago: 'PPD', forma_pago: '99' }), 'autorizar')).toBe('sin_verificar');
  });
  it('⭐ [PGP.229] S01 u otro régimen sin decisión: se programa, pero no se autoriza', () => {
    const s01 = rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_uso_cfdi: 'S01' });
    expect(detiene(s01, 'programar')).toBeNull();
    expect(detiene(s01, 'autorizar')).toBe('sin_efectos_fiscales');
    const regimen = rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_regimen: '606' });
    expect(detiene(regimen, 'programar')).toBeNull();
    expect(detiene(regimen, 'autorizar')).toBe('regimen');
    // Control: el IMSS (excepción por regla) y la comisión del banco no piden nada.
    expect(detiene(rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_regimen: '606', emisor_rfc: 'IMS421231I45' }), 'autorizar')).toBeNull();
    expect(detiene(rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_uso_cfdi: 'S01', emisor_rfc: 'BBA830831LJ2' }), 'autorizar')).toBeNull();
  });
  it('⭐ [PGP.229] el 409 de lo que pide decisión dice dónde se decide; el de lo que no tiene salida, no', () => {
    const motivo = detieneElPago(normaDelPago(rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_uso_cfdi: 'S01' }), '2026-10-30', '2026-10-29'), 'autorizar');
    if (!motivo) throw new Error('la S01 sin decisión debía detener al autorizar');
    expect(textoDelFreno([{ uuid: 'a1b2c3d4-0000', total: 11600, motivo }], 'autorizar')).toBe(
      'No se puede autorizar este pago — la factura de $11,600.00 (CFDI A1B2C3D4): Uso S01 (sin efectos fiscales): necesita la autorización de Administración o Contabilidad (decídela en Finanzas › Facturas fuera de norma)');
    const cancelada = detieneElPago(normaDelPago(rec({ estatus_sat: 'cancelado', metodo_pago: 'PPD', forma_pago: '99' }), '2026-10-30', '2026-10-29'), 'programar');
    if (!cancelada) throw new Error('la cancelada debía detener');
    expect(textoDelFreno([{ uuid: 'a1b2c3d4-0000', total: 1, motivo: cancelada }], 'programar')).not.toContain('decídela');
  });
  it('⛔ negada por Administración o Contabilidad, sí detiene; autorizada, ya ni avisa', () => {
    const c = rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_uso_cfdi: 'S01' });
    const n = normaDelPago(c, '2026-10-30', '2026-10-29', [{ regla: 'sin_efectos_fiscales', decision: 'no_se_usa' }]);
    expect(detieneElPago(n, 'programar')?.regla).toBe('sin_efectos_fiscales');
    expect(normaDelPago(c, '2026-10-30', '2026-10-29', [{ regla: 'sin_efectos_fiscales', decision: 'se_usa' }]).veredicto).toBe('apta');
  });
  it('la S01 de una comisión del banco no se trata como traslado ni pide nada: el Calendario la ve tipo I', () => {
    const c = rec({ emisor_rfc: 'BBA830831LJ2', metodo_pago: 'PPD', forma_pago: '99', receptor_uso_cfdi: 'S01' });
    expect(normaDelPago(c, '2026-10-30', '2026-10-29').veredicto).toBe('apta');
    expect(normaDelPago(rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_uso_cfdi: 'S01' }), '2026-10-30', '2026-10-29').veredicto)
      .toBe('requiere_autorizacion');   // control: otro emisor, tipo I, sí pide
  });
  it('un CFDI sin régimen (3.3) se dice pero no detiene la autorización', () => {
    expect(detiene(rec({ metodo_pago: 'PPD', forma_pago: '99', receptor_regimen: null }), 'autorizar')).toBeNull();
  });
  it('el mensaje dice qué factura y por qué, una por una', () => {
    const motivo = detieneElPago(normaDelPago(rec(), '2026-11-02', '2026-10-29'), 'programar');
    if (!motivo) throw new Error('la PUE de mes anterior debía detener');
    const t = textoDelFreno([{ uuid: 'a1b2c3d4-0000', total: 11600, motivo }], 'programar');
    expect(t).toBe('No se puede programar este pago — la factura de $11,600.00 (CFDI A1B2C3D4): PUE del 28-oct: su mes cerró el 31-oct y el pago sale el 2-nov. No se paga: pide al proveedor que la sustituya por PPD');
  });
});
