// Mismo stub que anexo-venta.spec.ts: el barrel de platform-core arrastra la cola.
vi.mock('@megadulces/platform-core', () => ({
  TenantKnexService: class {},
  TenantContextService: class {},
  applySmartSearch: () => undefined,
}));

import { GuiaCobranzaService } from './guia-cobranza.service';

/**
 * GT.17 — la guía imprime Total factura · Abonos/Pagos · Saldo. Las guías archivadas antes
 * (snapshot sin `formato`) se reimprimen con sus columnas de entonces: la copia dice lo mismo
 * que el papel firmado.
 */

const row = (over: Record<string, unknown> = {}) => ({
  folio_digital: '01-UD0801-0000874', sucursal: '01', doc_prefix: 'UD0801', folio: '0000874',
  fecha: '2026-08-28', cliente_code: 'C1015', cliente_nombre: 'JUAN PABLO FONSECA',
  cliente_domicilio: 'AV. REVOLUCIÓN 6', cliente_colonia: 'AYOTLAN', cliente_estado: 'JALISCO', cliente_cp: '47930',
  total: '3544.77', descuento_efectivo: '109.63', saldo: '1544.77', cobrado: '2000.00', estatus_cobro: 'parcial',
  ...over,
});

const svc = new GuiaCobranzaService({} as any, {} as any, {} as any, {} as any) as any;
const cabecera = { empresa: 'X', folio: 'GC-2026-00001', numero: 'n', fecha: 'f', total: 0, vendedor: 'V',
  documentos: 1, derivados: 0, responsable: '', nota: '' };

describe('GT.17 · columnas de la guía', () => {
  it('formato 2: Total factura, Abonos/Pagos y Saldo por renglón', () => {
    const clientes = svc.agrupar([row()]);
    const html: string = svc.html(clientes, { ...cabecera, formato: 2 });
    expect(html).toContain('Total factura');
    expect(html).toContain('Abonos/Pagos');
    expect(html).toContain('>Saldo<');
    expect(html).not.toContain('>Descuento<');
    expect(html).not.toContain('>Importe<');
    expect(html).toContain('3,544.77');
    expect(html).toContain('2,000.00');
    expect(html).toContain('1,544.77');
  });

  it('sin cartera: el abono no se sabe → "—", nunca 0.00; el saldo cae al total marcado ~', () => {
    const clientes = svc.agrupar([row({ saldo: null, cobrado: null, estatus_cobro: 'sin_cartera' })]);
    expect(clientes[0].movimientos[0].abonos).toBeNull();
    const html: string = svc.html(clientes, { ...cabecera, formato: 2, derivados: 1 });
    expect(html).toContain('<span class="nd">—</span>');
    expect(html).toContain('<i class="mk">~</i>');
  });

  it('totales del cliente suman las tres columnas', () => {
    const c = svc.agrupar([row(), row({ folio: '0000900', total: '1000.00', saldo: '1000.00', cobrado: '0.00' })])[0];
    expect(c.total_factura).toBeCloseTo(4544.77, 2);
    expect(c.abonos).toBeCloseTo(2000, 2);
    expect(c.total).toBeCloseTo(2544.77, 2);
  });

  it('snapshot viejo (sin formato) se reimprime con Descuento/Importe', () => {
    const viejo = [{ cliente_id: 'C1', nombre: 'A', direccion: 'd', descuento: 5, total: 10, derivado: false,
      movimientos: [{ folio: '1', fecha: '01/01/26', descuento: 5, importe: 10, derivado: false }] }];
    const html: string = svc.html(viejo, cabecera);
    expect(html).toContain('>Descuento<');
    expect(html).toContain('>Importe<');
    expect(html).not.toContain('Abonos/Pagos');
  });
});
