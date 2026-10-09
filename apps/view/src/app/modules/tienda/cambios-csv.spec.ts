import type { PriceChangeRow } from '@megadulces/contracts';
import { cambiosACsv, celdaCsv, nombreArchivoCambios } from './cambios-csv';

const fila = (sku: string, name: string, unidad: string, antes: number | null, ahora: number | null, hora: string | null = '10:00:00'): PriceChangeRow => ({
  sku, name, unidad, precio_anterior: antes, precio_nuevo: ahora,
  delta: antes == null || ahora == null ? null : Math.round((ahora - antes) * 100) / 100,
  es_baja: ahora === 0, hora,
});

/** `[ETQ-AVISOS.3]` El archivo que se descarga tiene que decir lo MISMO que la pantalla. */
describe('cambiosACsv', () => {
  const lineas = (csv: string): string[] => csv.trim().split('\r\n');

  it('⭐ lleva BOM UTF-8 (Excel abre los acentos bien), encabezado y fin de línea de Excel', () => {
    const csv = cambiosACsv([fila('1', 'CAÑA MÍNIMA', 'PAQ', 10, 12)]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.indexOf(String.fromCharCode(0xfeff), 1)).toBe(-1); // una sola vez
    expect(lineas(csv)[0]).toBe('Código,Producto,Presentación,Precio anterior,Precio nuevo,Diferencia,Cambio %,Estado');
    expect(csv).toContain('CAÑA MÍNIMA');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('⭐ misma regla que la pantalla: lo movido varias veces va como «antes → ahora» y una fila por presentación', () => {
    const csv = cambiosACsv([
      fila('91059', 'TURIN', 'CJA', 0, 6378.26, '08:00:00'),
      fila('91059', 'TURIN', '500', 6523.34, 203.85, '10:00:00'),
      fila('91059', 'TURIN', '500', 5602.87, 6523.34, '09:00:00'),
    ]);
    const l = lineas(csv);
    expect(l).toHaveLength(3); // encabezado + CJA + 500 (no 4)
    expect(l.find((x) => x.includes(',500,'))).toBe('91059,TURIN,500,5602.87,203.85,-5399.02,-96.4,Baja');
    // antes en $0 = precio nuevo: no hay proporción que calcular y la celda va vacía, no «Infinity»
    expect(l.find((x) => x.includes(',CJA,'))).toBe('91059,TURIN,CJA,0.00,6378.26,6378.26,,Sube');
  });

  it('lo que terminó el día en su mismo precio NO sale', () => {
    const csv = cambiosACsv([fila('9', 'OSCILA', 'PAQ', 10, 12, '09:00:00'), fila('9', 'OSCILA', 'PAQ', 12, 10, '10:00:00')]);
    expect(lineas(csv)).toHaveLength(1); // sólo el encabezado
  });

  it('lo que el ERP dejó sin precio se rotula, no se disfraza de rebaja', () => {
    const l = lineas(cambiosACsv([fila('7', 'SIN PRECIO', 'PAQ', 25, 0)]));
    expect(l[1]).toBe('7,SIN PRECIO,PAQ,25.00,0.00,-25.00,-100.0,Sin precio en Kepler');
  });

  it('⛔ un nombre que empieza con = + - @ no se ejecuta como fórmula en Excel', () => {
    for (const malo of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)']) {
      const l = lineas(cambiosACsv([fila('1', malo, 'PAQ', 1, 2)]));
      expect(l[1].split(',')[1].startsWith("'") || l[1].includes(`"'`)).toBe(true);
    }
  });

  it('las comas y las comillas del nombre no rompen las columnas', () => {
    const csv = cambiosACsv([fila('1', 'CHOCOLATE "BLANCO", 500 G', 'PAQ', 1, 2)]);
    expect(lineas(csv)[1]).toContain('"CHOCOLATE ""BLANCO"", 500 G"');
  });

  it('una lista vacía da sólo el encabezado, no revienta', () => {
    expect(lineas(cambiosACsv([]))).toHaveLength(1);
  });
});

describe('celdaCsv y nombreArchivoCambios', () => {
  it('nulos y undefined son celda vacía, no «null»', () => {
    expect(celdaCsv(null)).toBe('');
    expect(celdaCsv(undefined)).toBe('');
    expect(celdaCsv(0)).toBe('0');
  });

  it('el nombre del archivo lleva plaza y día, y no se deja engañar por valores raros', () => {
    expect(nombreArchivoCambios('01', '2026-10-08')).toBe('cambios-de-precio_01_2026-10-08.csv');
    expect(nombreArchivoCambios(null, '2026-10-08')).toBe('cambios-de-precio_todas_2026-10-08.csv');
    expect(nombreArchivoCambios('../x', 'hoy')).toBe('cambios-de-precio_todas_sin-fecha.csv');
  });
});
