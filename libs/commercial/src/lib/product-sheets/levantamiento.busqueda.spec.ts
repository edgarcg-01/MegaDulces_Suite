// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { filaBusqueda } from './levantamiento.service';

/**
 * `[NP.7.L.10]` El buscador del levantamiento reusa la consulta de Cotización nueva, que selecciona
 * PRECIO y VENTA. Quien captura no debe verlos (§10b.2): la fila sale por lista blanca. La prueba recorre
 * el JSON COMPLETO (no busca un solo campo), como pide el plan (§7.2).
 */
const PROHIBIDAS = ['piece_price', 'box_price', 'revenue', 'cost', 'costo', 'margin', 'margen', 'price', 'precio'];

function clavesProhibidas(v: unknown, ruta = ''): string[] {
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
    ...(PROHIBIDAS.some((p) => k.toLowerCase().includes(p)) ? [`${ruta}${k}`] : []),
    ...clavesProhibidas(x, `${ruta}${k}.`),
  ]);
}

// Una fila como la que devuelve la consulta interna de cotizaciones, con todo lo que trae.
const FILA_CRUDA = {
  sku: '02020', name: 'TRIDENT XTRA CARE MENTA /12', content: '12 pz', barcode: '7622210571403', unit_base: 'PZA',
  piece_price: '8.50', pack_size: '12', box_size: '384', box_price: '2661.94', sold_by_kg: false, revenue: '45210.00', photo_status: 'tiene_foto',
};

describe('buscador del levantamiento · lista blanca', () => {
  it('sólo sku, nombre, contenido, código y si ya tiene ficha', () => {
    const r = filaBusqueda(FILA_CRUDA);
    expect(Object.keys(r).sort()).toEqual(['barcode', 'content', 'name', 'photo_status', 'sku']);
    expect(r).toEqual({ sku: '02020', name: 'TRIDENT XTRA CARE MENTA /12', content: '12 pz', barcode: '7622210571403', photo_status: 'tiene_foto' });
  });

  it('⭐ ni precio ni venta en ningún nivel del JSON', () => {
    expect(clavesProhibidas([filaBusqueda(FILA_CRUDA)])).toEqual([]);
  });

  it('prueba negativa: el detector SÍ caza un precio colado (si no, el candado sería decorativo)', () => {
    expect(clavesProhibidas([{ ...filaBusqueda(FILA_CRUDA), box_price: 1 }])).toEqual(['0.box_price']);
    expect(clavesProhibidas(FILA_CRUDA)).toEqual(expect.arrayContaining(['piece_price', 'box_price', 'revenue']));
  });

  it('[NP.7.L.22] photo_status pasa sólo con uno de los tres valores; otro valor no se inventa como «tiene foto»', () => {
    for (const v of ['tiene_foto', 'en_curso', 'falta']) expect(filaBusqueda({ ...FILA_CRUDA, photo_status: v }).photo_status).toBe(v);
    expect(filaBusqueda({ ...FILA_CRUDA, photo_status: 't' }).photo_status).toBe('falta');
    expect(filaBusqueda({ ...FILA_CRUDA, photo_status: null }).photo_status).toBe('falta');
  });
});
