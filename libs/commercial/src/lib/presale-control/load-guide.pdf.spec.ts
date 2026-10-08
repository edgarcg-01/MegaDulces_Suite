/**
 * `[MCP.5]` Pruebas del HTML de la guía de carga. Puro: no levanta Chromium ni base.
 */
import { htmlGuiaCarga, pieGuiaCarga, type LoadGuideSnapshot } from './load-guide.pdf';

const snap = (over: Partial<LoadGuideSnapshot> = {}): LoadGuideSnapshot => ({
  version: 1,
  empresa: 'Mega Dulces',
  folio: 'GDC-2026-00041',
  sucursal: '04',
  sucursal_nombre: 'Yurécuaro',
  ruta: 'RUTA 21',
  repartidor: 'Luis G.',
  fecha: '2026-10-08',
  impresa_en: '2026-10-08T14:20:00.000Z',
  impresa_por: 'Rosa M.',
  pedidos: [
    { code: 'PD-2026-00053', cliente: 'ARMANDO GARCIA', cliente_code: '4', entrega: '2026-10-01', folio_digital: '04UD1003-0002097', document_total: 1564.75, total: 1700.12 },
    { code: 'PD-2026-00070', cliente: 'Abarrotes El Sol', cliente_code: '10111', entrega: '2026-10-08', folio_digital: null, document_total: null, total: 965.4 },
  ],
  total: 2530.15,
  ...over,
});

describe('htmlGuiaCarga', () => {
  it('lista cada pedido con su documento, y "se elige al entregar" cuando aún no hay', () => {
    const h = htmlGuiaCarga(snap(), { reimpresion: false });
    expect(h).toContain('PD-2026-00053');
    expect(h).toContain('04UD1003-0002097');
    expect(h).toContain('se elige al entregar');
    expect(h).toContain('RUTA 21');
    expect(h).toContain('01/10/2026');
  });

  it('el importe usa el documento cuando está ligado y si no el pedido; el total es el del snapshot', () => {
    const h = htmlGuiaCarga(snap(), { reimpresion: false });
    expect(h).toContain('$1,564.75');
    expect(h).not.toContain('$1,700.12');
    expect(h).toContain('$965.40');
    expect(h).toContain('$2,530.15');
  });

  it('negativa: la primera impresión NO dice reimpresión; la copia sí', () => {
    expect(htmlGuiaCarga(snap(), { reimpresion: false })).not.toContain('REIMPRESIÓN');
    expect(htmlGuiaCarga(snap(), { reimpresion: true, reimpresa_en: '8/10/2026' })).toContain('REIMPRESIÓN · 8/10/2026');
  });

  it('escapa lo que viene de la base (un nombre de cliente no inyecta HTML)', () => {
    const h = htmlGuiaCarga(snap({ pedidos: [{ ...snap().pedidos[0], cliente: '<script>x</script>' }] }), { reimpresion: false });
    expect(h).not.toContain('<script>x</script>');
    expect(h).toContain('&lt;script&gt;');
  });

  it('lleva las dos firmas: quien recibe la carga y quien la entrega en caja', () => {
    const h = htmlGuiaCarga(snap(), { reimpresion: false });
    expect(h).toContain('Nombre y firma de quien recibe la carga');
    expect(h).toContain('Nombre y firma de quien entrega (caja)');
    expect(h).toContain('Luis G.');
    expect(h).toContain('Rosa M.');
  });

  it('el pie trae el folio', () => {
    expect(pieGuiaCarga('GDC-2026-00041', 'impresa 8/10/2026')).toContain('GDC-2026-00041');
  });
});
