import { armarPagoKepler, type PagoKeplerEntrada } from './pago-kepler.armador';
import { compararConCaptura, type CapturaKepler } from './ensayo-pago-kepler';

/**
 * `[PGP.105]` El ensayo compara el `X-D-26` que la Suite armaría contra el que Tesorería capturó.
 * El plan sale del armador REAL (no de un objeto a mano): si el armador cambia, esto lo ve.
 */
const entrada = (o: Partial<PagoKeplerEntrada> = {}): PagoKeplerEntrada => ({
  sucursal: '00', fecha: '2026-11-04', hora: '12:00', referencia: 'PGP-1', importe: 1160, cuentaTesoreria: '0005',
  destino: 'BBVA · CLABE 032180000118359719',
  proveedor: { codigo: 'C0001', rfc: 'GAM010101AB1', nombre: 'GAMAHUBIN', domicilio: ['', '', ''], dias: 30 },
  facturas: [{ almacen: '00', tipo: 20, subtipo: 1, folio: '0009469', concepto: 'C-001', saldo: 1160, aplicado: 1160, iva: 160, ieps: 0, total: 1160 }],
  ...o,
});
const plan = () => { const r = armarPagoKepler(entrada()); if (!r.ok) throw new Error(r.motivos.join()); return r.plan; };
const real = (o: Partial<CapturaKepler> = {}): CapturaKepler => ({
  folio: '0017253', acreedor: 'C0001', importe: 1160, cuenta: '0005', concepto: 'C-001', iva: 160, ieps: 0,
  aplicaciones: { '20-1-0009469': 1160 }, ...o,
});

describe('[PGP.105] el ensayo contra la captura de Tesorería', () => {
  it('⭐ lo mismo que capturó Tesorería: coincide', () => {
    expect(compararConCaptura(plan(), real())).toEqual({ coincide: true, diferencias: [] });
  });
  it('centavos de redondeo no son diferencia', () => {
    expect(compararConCaptura(plan(), real({ importe: 1160.004, iva: 160.009 })).coincide).toBe(true);
  });
  it('⛔ otra cuenta de tesorería, otro concepto u otro importe: se dice cuál', () => {
    const r = compararConCaptura(plan(), real({ cuenta: '0011', concepto: 'C-010', importe: 1100 }));
    expect(r.coincide).toBe(false);
    expect(r.diferencias.join(' | ')).toMatch(/Cuenta de tesorería.*0011/);
    expect(r.diferencias.join(' | ')).toMatch(/Concepto.*C-010/);
    expect(r.diferencias.join(' | ')).toMatch(/Importe/);
  });
  it('⛔ una factura que sólo una de las dos paga, o con otro importe', () => {
    expect(compararConCaptura(plan(), real({ aplicaciones: { '20-1-0009469': 1000 } })).diferencias[0]).toMatch(/aplica \$1160.00, Tesorería \$1000.00/);
    expect(compararConCaptura(plan(), real({ aplicaciones: { '20-1-0009469': 1160, '20-1-0009999': 50 } })).diferencias[0]).toMatch(/la Suite no la paga/);
    expect(compararConCaptura(plan(), real({ aplicaciones: {} })).diferencias[0]).toMatch(/Tesorería no la pagó/);
  });
  it('⛔ otro IVA (el proporcional de la Suite contra el de Tesorería)', () => {
    expect(compararConCaptura(plan(), real({ iva: 150 })).diferencias[0]).toMatch(/IVA/);
  });
});
