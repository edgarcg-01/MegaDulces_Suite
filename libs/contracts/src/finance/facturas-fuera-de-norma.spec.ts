import { armarBandejaFueraDeNorma, desdeDeLaBandeja, type CfdiDeLaBandeja, type DecisionTomada, type PagoConLaFactura } from './facturas-fuera-de-norma.contract';

// Una recibida tipo I en regla: PPD, G03, a nuestro nombre con 612.
const cfdi = (uuid: string, o: Partial<CfdiDeLaBandeja> = {}): CfdiDeLaBandeja => ({
  uuid, rol: 'recibidas', fecha: '2026-10-28', estatus_sat: 'vigente', metodo_pago: 'PPD', forma_pago: '99',
  receptor_uso_cfdi: 'G03', receptor_regimen: '612', emisor_regimen: '601', emisor_rfc: 'GAM010101AB1', tipo_comprobante: 'I',
  emisor_nombre: 'PROVEEDOR', serie_folio: 'A-1', total: 1160, ...o,
});
const decision = (o: Partial<DecisionTomada> = {}): DecisionTomada => ({
  id: 'd1', regla: 'sin_efectos_fiscales', decision: 'se_usa', motivo: 'Gasto de la empresa', por: 'mgarcia', cuando: '2026-11-20T10:00:00.000Z', ...o,
});
const pago = (fecha: string, o: Partial<PagoConLaFactura> = {}): PagoConLaFactura => ({ allocation_id: `p-${fecha}`, fecha, folio: null, autorizado: false, ...o });
const armar = (cfdis: CfdiDeLaBandeja[], o: { decisiones?: [string, DecisionTomada[]][]; pagos?: [string, PagoConLaFactura[]][]; hoy?: string } = {}) =>
  armarBandejaFueraDeNorma({ cfdis, decisiones: new Map(o.decisiones ?? []), pagos: new Map(o.pagos ?? []), hoy: o.hoy ?? '2026-11-26', leido_en: 'X' });
const uuids = (fs: { uuid: string }[]) => fs.map((f) => f.uuid);

describe('[PGP.229] la bandeja «Facturas fuera de norma»', () => {
  it('⭐ entra lo que pide decisión, con la regla que la pide', () => {
    const b = armar([cfdi('S', { receptor_uso_cfdi: 'S01' }), cfdi('R', { receptor_regimen: '606' }), cfdi('OK')]);
    expect(b.por_decidir.map((f) => `${f.uuid}:${f.por_decidir.join('+')}`)).toEqual(['R:regimen', 'S:sin_efectos_fiscales']);
    expect(b.decididas).toEqual([]);
  });

  it('⛔ no entra lo que la regla exceptúa ni lo que no se puede revisar', () => {
    const b = armar([
      cfdi('IMSS', { receptor_regimen: '606', emisor_rfc: 'IMS421231I45' }),
      cfdi('BANCO', { receptor_uso_cfdi: 'S01', emisor_rfc: 'BBA830831LJ2' }),
      cfdi('TRASLADO', { receptor_uso_cfdi: 'S01', tipo_comprobante: 'T' }),
      cfdi('SIN-REGIMEN', { receptor_regimen: null }),
    ]);
    expect(b.por_decidir).toEqual([]);
    expect(b.decididas).toEqual([]);
  });

  it('⭐ decidida en todo lo que pide, pasa a «decididas» (se usa o no se usa)', () => {
    const b = armar([cfdi('si', { receptor_uso_cfdi: 'S01' }), cfdi('no', { receptor_uso_cfdi: 'S01' })], {
      decisiones: [['si', [decision()]], ['no', [decision({ id: 'd2', decision: 'no_se_usa' })]]],
    });
    expect(b.por_decidir).toEqual([]);
    expect(uuids(b.decididas).sort()).toEqual(['no', 'si']);
  });

  it('⛔ con S01 decidida y el régimen pendiente, sigue por decidir y muestra la decisión que ya hay', () => {
    const b = armar([cfdi('ambas', { receptor_uso_cfdi: 'S01', receptor_regimen: '606' })], { decisiones: [['ambas', [decision()]]] });
    expect(b.por_decidir[0].por_decidir).toEqual(['regimen']);
    expect(b.por_decidir[0].decisiones.map((d) => d.regla)).toEqual(['sin_efectos_fiscales']);
  });

  it('⭐ el orden: primero lo que ya está en un pago (el que sale antes), luego la más nueva', () => {
    const b = armar([
      cfdi('vieja', { receptor_uso_cfdi: 'S01', fecha: '2026-09-01' }),
      cfdi('nueva', { receptor_uso_cfdi: 'S01', fecha: '2026-11-20' }),
      cfdi('pago-tarde', { receptor_uso_cfdi: 'S01', fecha: '2026-08-01' }),
      cfdi('pago-pronto', { receptor_uso_cfdi: 'S01', fecha: '2026-07-01' }),
    ], { pagos: [['pago-tarde', [pago('2026-12-05')]], ['pago-pronto', [pago('2026-12-10'), pago('2026-11-28')]]] });
    expect(uuids(b.por_decidir)).toEqual(['pago-pronto', 'pago-tarde', 'nueva', 'vieja']);
    expect(b.por_decidir[0].pagos.map((p) => p.fecha)).toEqual(['2026-11-28', '2026-12-10']);   // el más próximo primero
  });

  it('las decididas: la decisión más nueva primero', () => {
    const b = armar([cfdi('a', { receptor_uso_cfdi: 'S01' }), cfdi('b', { receptor_uso_cfdi: 'S01' })], {
      decisiones: [['a', [decision({ cuando: '2026-11-01T00:00:00.000Z' })]], ['b', [decision({ id: 'd2', cuando: '2026-11-25T00:00:00.000Z' })]]],
    });
    expect(uuids(b.decididas)).toEqual(['b', 'a']);
  });

  it('⭐ el UUID se cruza en minúsculas (prod los guarda en MAYÚSCULAS) y no se repite', () => {
    const b = armar([cfdi('AAAA-1', { receptor_uso_cfdi: 'S01' }), cfdi('aaaa-1', { receptor_uso_cfdi: 'S01' })], {
      decisiones: [['aaaa-1', [decision()]]], pagos: [['aaaa-1', [pago('2026-12-01')]]],
    });
    expect(b.por_decidir).toEqual([]);
    expect(b.decididas).toHaveLength(1);
    expect(b.decididas[0].uuid).toBe('AAAA-1');            // se muestra como está en fiscal.cfdis
    expect(b.decididas[0].pagos).toHaveLength(1);
  });

  it('la norma se mide contra el pago más próximo: una PUE de octubre en un pago de noviembre lo dice', () => {
    const b = armar([cfdi('pue', { receptor_uso_cfdi: 'S01', metodo_pago: 'PUE', forma_pago: '03', fecha: '2026-10-28' })], {
      pagos: [['pue', [pago('2026-11-03')]]], hoy: '2026-10-29',
    });
    expect(b.por_decidir[0].motivos.map((m) => m.regla)).toEqual(['pue_mes_anterior', 'sin_efectos_fiscales']);
    // Sin pago, contra hoy (29-oct): todavía dentro de su mes.
    const sinPago = armar([cfdi('pue', { receptor_uso_cfdi: 'S01', metodo_pago: 'PUE', forma_pago: '03', fecha: '2026-10-28' })], { hoy: '2026-10-29' });
    expect(sinPago.por_decidir[0].motivos.map((m) => m.regla)).toEqual(['sin_efectos_fiscales']);
  });

  it('desde: el 1-ene del año anterior', () => {
    expect(desdeDeLaBandeja('2026-11-26')).toBe('2025-01-01');
    expect(armar([]).desde).toBe('2025-01-01');
  });
});
