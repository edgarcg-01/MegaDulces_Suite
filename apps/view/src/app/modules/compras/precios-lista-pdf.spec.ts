import type { FilaListaPrecios } from '@megadulces/contracts';
import { celdaUnidad, filasPdf } from './precios-lista-pdf';

const fila = (sku: string, nombre: string, linea: string | null, over: Partial<FilaListaPrecios> = {}): FilaListaPrecios => ({
  sku, nombre,
  linea: { codigo: linea ? '1' : null, nombre: linea },
  tipo: { codigo: '001', nombre: 'DULCES' },
  grupo: { codigo: null, nombre: null },
  iva: 0, ieps: -8,
  unidades: [
    { n: 1, unidad: 'PZA', factor: 1, conversion: '1 PZA', precio: 20, margen_pct: 25.5, volumen: [{ desde: 3, precio: 16 }], codigos: ['70001'], cambio: null },
    { n: 2, unidad: 'PAQ', factor: 10, conversion: 'PAQ = 10 PZA', precio: 200, margen_pct: 12, volumen: [{ desde: 3, precio: 190 }], codigos: [], cambio: null },
    { n: 3, unidad: 'CJA', factor: 140, conversion: 'CJA = 14 PAQ = 140 PZA', precio: 2000, margen_pct: 8, volumen: [{ desde: 3, precio: 1950 }], codigos: ['C70001'], cambio: null },
  ],
  ...over,
});

describe('[CAT-PRECIO.2] PDF de la lista de precios', () => {
  it('cada unidad con su precio y debajo el cambio automático (el ejemplo de Compras)', () => {
    const r = filasPdf([fila('70001', 'MAZAPAN DE LA ROSA', 'LA ROSA')], 'articulo');
    expect(r).toHaveLength(1);
    const c = (r[0] as { celdas: string[] }).celdas;
    expect(c.slice(0, 2)).toEqual(['70001', 'MAZAPAN DE LA ROSA']);
    expect(c[2]).toContain('PZA');
    expect(c[2]).toContain('Desde 3:');
    expect(c[4]).toContain('CJA');
    expect(c[5]).toBe('IEPS 8% incl.');
  });

  it('cada código de barras va debajo de SU unidad, no en una columna aparte', () => {
    const c = (filasPdf([fila('70001', 'MAZAPAN', 'LA ROSA')], 'articulo')[0] as { celdas: string[] }).celdas;
    expect(c[2].split('\n')).toEqual(['PZA  $20.00', 'Desde 3: $16.00', '70001']);
    expect(c[3]).not.toContain('70001');
    expect(c[4].split('\n').pop()).toBe('C70001');
  });

  it('NEGATIVA: el margen NUNCA llega al PDF del cliente', () => {
    const r = filasPdf([fila('70001', 'MAZAPAN', 'LA ROSA')], 'articulo');
    const texto = JSON.stringify(r);
    expect(texto).not.toContain('25.5');
    expect(texto).not.toContain('margen');
    expect((r[0] as { celdas: string[] }).celdas).toHaveLength(6);
  });

  it('agrupado por línea: un renglón de título por grupo, lo vacío como «Sin asignar»', () => {
    const r = filasPdf([fila('1', 'A', 'LA ROSA'), fila('2', 'B', 'LA ROSA'), fila('3', 'C', null)], 'linea');
    expect(r.map((x) => ('grupo' in x ? `# ${x.grupo}` : (x as { celdas: string[] }).celdas[0]))).toEqual(['# LA ROSA', '1', '2', '# Sin asignar', '3']);
  });

  it('la conversión va debajo del precio en la unidad 2 y 3 (en la base no, «1 PZA» es ruido)', () => {
    const c = (filasPdf([fila('70001', 'MAZAPAN', 'LA ROSA')], 'articulo')[0] as { celdas: string[] }).celdas;
    expect(c[2]).not.toContain('1 PZA');
    expect(c[3].split('\n')[1]).toBe('PAQ = 10 PZA');
    expect(c[4].split('\n')[1]).toBe('CJA = 14 PAQ = 140 PZA');
  });

  it('unidad que la ficha no tiene = celda vacía; sin precio se dice', () => {
    expect(celdaUnidad(undefined)).toBe('');
    expect(celdaUnidad({ n: 2, unidad: 'CJA', factor: 12, conversion: null, precio: null, margen_pct: null, volumen: [], codigos: [], cambio: null })).toBe('CJA  sin precio');
  });
});
