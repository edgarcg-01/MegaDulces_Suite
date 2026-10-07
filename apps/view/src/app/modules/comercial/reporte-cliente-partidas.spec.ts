import { cuerpoReporteCliente } from './reporte-cliente-papel';
import type { ClienteCandidato, ReporteDocumento, ReporteLinea, ReporteFiltrosUI } from './tickets.service';

/**
 * `[TK.11]` El detalle por producto en el papel del reporte.
 *
 * Lo que se fija acá es **cuándo el papel habla y cuándo se calla**, que es donde un reporte
 * miente sin fallar:
 *
 *  · `lineas` tiene TRES estados y los tres se imprimen distinto — `null` (no se pidió el
 *    detalle), `[]` (se pidió y el ERP no tiene partidas) y con elementos. Confundir los dos
 *    primeros haría que una compra apareciera como si no hubiera llevado productos.
 *  · el **descuento por pieza** se deriva del precio de lista: sin lista no se sabe cuánto se
 *    bajó por unidad, y un `0.00` afirmaría que no hubo descuento.
 *  · las cinco columnas de dinero son las mismas que el ticket en carta, y **ninguna más**: sin
 *    neto y sin impuesto por renglón, que es lo que el usuario sacó por confundir al cliente.
 */

const C: ClienteCandidato = {
  cliente_code: '10448', nombre: 'ABARROTES LA ESPERANZA SA DE CV', ciudad: 'Zamora',
  zona: 'CENTRO', plazas: 9, clave_ambigua: false, score: 1,
};

const L = (p: Partial<ReporteLinea> = {}): ReporteLinea => ({
  linea: 1, sku: '70043', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
  cantidad: 12, precio_lista: 6, lista_conocida: true, precio_pagado: 5,
  descuento_unitario: 1, descuento_linea: 12, importe: 60, ...p,
});

const D = (p: Partial<ReporteDocumento> = {}): ReporteDocumento => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Mostrador', sucursal: '05',
  sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440', fecha: '2026-09-18',
  atendio: 'Rosa Maria', descuento: 12, total: 60, ...p,
});

const SIN: ReporteFiltrosUI = {};

describe('TK.11 · las partidas bajo cada compra', () => {
  it('imprime las cinco columnas de dinero, y sus valores', () => {
    const h = cuerpoReporteCliente(C, [D({ lineas: [L()] })], SIN, 0);
    expect(h).toContain('Precio original');
    expect(h).toContain('Precio con desc.');
    expect(h).toContain('Desc. por pieza');
    expect(h).toContain('Descuento total');
    expect(h).toContain('PALETA PAYASO CHICO 20G');
  });

  /** ⛔ Lo que el usuario sacó del papel por confundir al cliente. */
  it('NO imprime neto ni impuesto por renglón', () => {
    const h = cuerpoReporteCliente(C, [D({ lineas: [L()] })], SIN, 0);
    expect(h).not.toContain('Neto');
    expect(h).not.toContain('Desc. por pieza</td><td class="r">IEPS');
  });

  /** Sin pedir el detalle, el papel queda exactamente como estaba. */
  it('con lineas en null no imprime ninguna partida', () => {
    const h = cuerpoReporteCliente(C, [D({ lineas: null })], SIN, 0);
    expect(h).not.toContain('Precio original');
    expect(h).toContain('05UD1005-0006440');
  });

  it('sin el campo tampoco (una respuesta vieja del backend no rompe el papel)', () => {
    const h = cuerpoReporteCliente(C, [D()], SIN, 0);
    expect(h).not.toContain('Precio original');
  });

  /** ⚠️ `[]` NO es `null`: se pidió el detalle y esta compra no lo tiene. Se DICE. */
  it('con lineas vacías lo declara en vez de callarlo', () => {
    const h = cuerpoReporteCliente(C, [D({ lineas: [] })], SIN, 0);
    expect(h).toContain('no tiene detalle de productos');
  });

  it('sin precio de lista no inventa un descuento por pieza', () => {
    const h = cuerpoReporteCliente(C, [D({
      lineas: [L({ lista_conocida: false, descuento_unitario: 0, descuento_linea: 0 })],
    })], SIN, 0);
    expect(h).toContain('sin dato');
    expect(h).not.toContain('-$0.00');
  });

  /** El nombre del producto viene de Kepler: si trae `<` o `&`, no puede romper el papel. */
  it('escapa la descripción del producto', () => {
    const h = cuerpoReporteCliente(C, [D({
      lineas: [L({ descripcion: 'PALETA <script>alert(1)</script> & CIA' })],
    })], SIN, 0);
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
  });

  it('varias compras conservan cada una sus propias partidas', () => {
    const h = cuerpoReporteCliente(C, [
      D({ id: 'A', lineas: [L({ descripcion: 'PRODUCTO A' })] }),
      D({ id: 'B', lineas: [L({ descripcion: 'PRODUCTO B' })] }),
    ], SIN, 0);
    expect(h.indexOf('PRODUCTO A')).toBeLessThan(h.indexOf('PRODUCTO B'));
  });
});
