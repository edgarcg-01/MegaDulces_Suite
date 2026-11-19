import { describe, expect, it } from 'vitest';
import { etiquetasDelRenglon, type BoxLabelLineRow } from '@megadulces/contracts';
import { documentoVistaPrevia, leerConsecutivos, rangoMx } from './etiquetas-caja-impresion';

describe('[RE.ETQ.3.3] leerConsecutivos — liberal con la forma, estricto con el significado', () => {
  it.each([
    ['7', [7]],
    ['3-5', [3, 4, 5]],
    ['3 - 5', [3, 4, 5]],
    ['1, 4-6', [1, 4, 5, 6]],
    ['7 9', [7, 9]],
    ['5,5,2', [2, 5]],
    ['2–4', [2, 3, 4]],
  ])('«%s» → %j', (texto, esperado) => {
    expect(leerConsecutivos(texto, 20)).toEqual(esperado);
  });

  it.each([
    ['', /Escribe/],
    ['21', /de 1 a 20/],
    ['0', /de 1 a 20/],
    ['5-3', /al revés/],
    ['siete', /No entendí/],
    ['3-', /No entendí/],
  ])('⛔ «%s» es error, no se adivina', (texto, error) => {
    expect(leerConsecutivos(texto, 20)).toMatch(error);
  });
});

describe('rangoMx', () => {
  it('7 días en CDMX: a las 23:30 del 17-nov (05:30 UTC del 18) el rango termina el 17', () => {
    expect(rangoMx(7, new Date('2026-11-18T05:30:00Z'))).toEqual({ date_from: '2026-11-11', date_to: '2026-11-17' });
  });
  it('hoy = un día', () => {
    expect(rangoMx(1, new Date('2026-11-19T16:00:00Z'))).toEqual({ date_from: '2026-11-19', date_to: '2026-11-19' });
  });
});

describe('documentoVistaPrevia', () => {
  it('es un documento aislado con el CSS de la etiqueta y las etiquetas', () => {
    const l: BoxLabelLineRow = {
      sucursal: '08', sucursal_nombre: 'Sucursal Morelia Abastos', serie: 1, folio: '0000474', linea: 1, sku: '70106',
      nombre: 'LA ROSA BOTA GRANDE 418GR', unidad: 'CJA', unidad_base: 'PZA', uxc: 18, cajas: 20, cajas_completas: 20,
      piezas_sueltas: 0, codigo: 'C70106', kepler_unidad_caja: 'CJA', kepler_factor_caja: 18, kepler_codigo_caja: 'C70106', sin_catalogo: false,
    };
    const doc = documentoVistaPrevia(etiquetasDelRenglon(l, '322-26', [1, 2, 3]));
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('.ec-bar{');
    expect((doc.match(/class="et ec"/g) ?? []).length).toBe(3);
    expect(doc).toContain('322-26');
  });

  it('no deja margen ni barras: la fila de 100 mm cabe entera en el iframe de 100 mm', () => {
    const doc = documentoVistaPrevia([]);
    expect(doc).toContain('html,body{margin:0;padding:0;overflow:hidden;');
  });
});
