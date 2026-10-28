/**
 * `[MCP.7]` Comprobante de liquidación: lo PENDIENTE (regresa a la sucursal) va arriba y lo entregado
 * y liquidado abajo, cada bloque con su subtotal (pedido de Francisco, 2026-10-10).
 */
import { htmlLiquidacion, type LiquidationSnapshot } from './load-guide-liquidation.pdf';

const base: LiquidationSnapshot = {
  version: 1, empresa: 'Mega Dulces', folio: 'LQP-2026-00001', sucursal: '07', sucursal_nombre: 'Morelia Madero',
  repartidor: 'Repartidor', liquidada_por: 'Cajera', liquidada_en: '2026-10-10T10:00:00Z', fecha: '2026-10-10',
  guias: [{ folio: 'GDC-2026-00001', ruta: 'RUTA 1' }],
  pedidos: [
    { guia: 'GDC-2026-00001', code: 'PD-1', cliente: 'A', folio_digital: '07UD1003-0000001', estado: 'entregado', resultado: 'completo', document_total: 1000, efectivo: 700, transferencia: 300, referencia: 'SPEI 1', nota: null },
    { guia: 'GDC-2026-00001', code: 'PD-2', cliente: 'B', folio_digital: '07UD1003-0000002', estado: 'no_entregado', resultado: null, document_total: 400, efectivo: null, transferencia: null, referencia: null, nota: 'Local cerrado' },
    { guia: 'GDC-2026-00001', code: 'PD-3', cliente: 'C', folio_digital: '07UD1003-0000003', estado: 'entregado', resultado: 'con_diferencia', document_total: 500, efectivo: 450, transferencia: 0, referencia: null, nota: 'Faltó una caja' },
    { guia: 'GDC-2026-00001', code: 'PD-4', cliente: 'D', folio_digital: null, estado: 'regreso', resultado: null, document_total: null, pedido_total: 100, efectivo: null, transferencia: null, referencia: null, nota: 'No estaba' },
  ],
  documents_total: 1500, documentos_sin_total: 0, declared_cash: 1150, declared_transfer: 300,
  counted_cash: 1150, cash_difference: 0, por_cobrar: 50, sin_explicar: 0,
  conteo: [{ label: '$1,000', piezas: 1, importe: 1000 }], notas: null,
};

describe('htmlLiquidacion', () => {
  const html = htmlLiquidacion(base, { reimpresion: false });

  it('los pendientes van ARRIBA de los entregados', () => {
    const iPend = html.indexOf('Pendientes: regresan a la sucursal (2)');
    const iEnt = html.indexOf('Entregados y liquidados (2)');
    expect(iPend).toBeGreaterThan(-1);
    expect(iEnt).toBeGreaterThan(iPend);
    // Cada pedido en su bloque.
    expect(html.indexOf('PD-2')).toBeLessThan(iEnt);
    expect(html.indexOf('PD-4')).toBeLessThan(iEnt);
    expect(html.indexOf('PD-1')).toBeGreaterThan(iEnt);
    expect(html.indexOf('PD-3')).toBeGreaterThan(iEnt);
  });

  it('cada bloque trae su subtotal', () => {
    expect(html).toContain('Valor de lo que regresa</td><td class="r mono">$500.00');
    expect(html).toMatch(/Subtotal entregado<\/td><td class="r mono">\$1,500\.00<\/td><td class="r mono">\$1,150\.00<\/td><td class="r mono">\$300\.00/);
  });

  it('lo que regresa sin documento vale el total del pedido, marcado', () => {
    expect(html).toContain('$100.00<div class="nd">del pedido</div>');
  });

  it('negativa: sin pendientes no se pinta el bloque de pendientes', () => {
    const solo = htmlLiquidacion({ ...base, pedidos: base.pedidos.filter((p) => p.estado === 'entregado') }, { reimpresion: false });
    expect(solo).not.toContain('Pendientes: regresan');
    expect(solo).toContain('Entregados y liquidados (2)');
  });
});

describe('htmlLiquidacion: un pedido que volvió en dos guías', () => {
  it('es UN renglón y su valor cuenta UNA vez (negativa del doble conteo)', () => {
    const dos = htmlLiquidacion({
      ...base,
      guias: [{ folio: 'GDC-A', ruta: 'R' }, { folio: 'GDC-B', ruta: 'R' }],
      pedidos: [
        { guia: 'GDC-A', code: 'PD-9', cliente: 'X', folio_digital: '07UD1003-0000009', estado: 'no_entregado', resultado: null, document_total: 742, efectivo: null, transferencia: null, referencia: null, nota: 'Intento 2' },
        { guia: 'GDC-B', code: 'PD-9', cliente: 'X', folio_digital: '07UD1003-0000009', estado: 'no_entregado', resultado: null, document_total: 742, efectivo: null, transferencia: null, referencia: null, nota: 'Intento 3' },
      ],
    }, { reimpresion: false });
    expect(dos).toContain('Pendientes: regresan a la sucursal (1)');
    expect(dos).toContain('Valor de lo que regresa</td><td class="r mono">$742.00');
    expect(dos).toContain('GDC-A, GDC-B');
    expect(dos).toContain('Intento 2 · Intento 3');
  });

  it('[MCP.3.13] con recolección de otra sucursal, dice cuánto cobró el Kepler de cada una', () => {
    const conPartes = htmlLiquidacion({
      ...base,
      por_sucursal: [
        { sucursal: '07', sucursal_nombre: 'Morelia Madero', documents_total: 1000, documentos_sin_total: 0, entregados: 1 },
        { sucursal: '08', sucursal_nombre: null, documents_total: 500, documentos_sin_total: 1, entregados: 2 },
      ],
    }, { reimpresion: false });
    expect(conPartes).toContain('Cobrado en el Kepler de 07 Morelia Madero (1)</td><td class="r mono">$1,000.00');
    expect(conPartes).toContain('Cobrado en el Kepler de 08 (2) · 1 sin total</td><td class="r mono">$500.00');
    // Una sola sucursal (y las fotos viejas, sin el campo): no se agrega nada.
    expect(htmlLiquidacion(base, { reimpresion: false })).not.toContain('Cobrado en el Kepler de');
  });
});
