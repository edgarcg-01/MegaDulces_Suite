import { describe, expect, it } from 'vitest';
import { GEOMETRIA_TSC_3X, MM_POR_MODULO, PAGINA_TSC_3X, modulosCode128 } from '@megadulces/ui-web';
import { CSS_ETIQUETA_UBICACION, etiquetasUbicacionHtml, tamanoCodigo } from './etiqueta-ubicacion';

/**
 * `[UB.RF.14]` La etiqueta de ubicación de tienda en la TSC TE200, rollo amarillo (igual al blanco de checado:
 * 3 por fila, 32 × 48 mm). Es la etiquetera compartida; aquí se prueba lo que la hace legible en el anaquel.
 */

const U = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `TA0${11 + i}`.slice(0, 5), label: 'Tienda · nivel 1', almacen: '01' }));

describe('[UB.RF.14] etiqueta de ubicación · TSC TE200', () => {
  it('⭐ sale en filas de 3, una hoja de la TSC por fila: 7 etiquetas = 3 filas, la última con 1', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(7)), 'text/html');
    const filas = doc.querySelectorAll('.et-fila');
    expect(filas.length).toBe(3);
    expect(Array.from(filas).map((f) => f.querySelectorAll('.et').length)).toEqual([3, 3, 1]);
    expect(CSS_ETIQUETA_UBICACION).toContain('width:100mm;height:47.6mm');
    expect(PAGINA_TSC_3X).toBe('size: 100mm 48mm; margin: 0;');
  });

  it('cada etiqueta lleva su código grande, su CODE128 y arriba el almacén y el rótulo', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(1)), 'text/html');
    expect(doc.querySelector('.eu-code')?.textContent).toBe('TA011');
    expect(doc.querySelector('.eu-arriba')?.textContent).toBe('01 · Tienda · nivel 1');
    expect(doc.querySelector('svg.eu-bar')).not.toBeNull();
  });

  it('⭐ las barras van a 2 puntos de 203 dpi por módulo (0.25 mm) y dejan zona quieta de 10 módulos por lado', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(1)), 'text/html');
    const modulos = modulosCode128('TA011')!;
    const ancho = modulos * MM_POR_MODULO;
    expect(doc.querySelector('svg.eu-bar')?.getAttribute('style')).toContain(`width:${ancho}mm`);
    const util = GEOMETRIA_TSC_3X.etiquetaMm - 2 * 1.5;
    expect((util - ancho) / 2).toBeGreaterThanOrEqual(10 * MM_POR_MODULO);
  });

  it('NEGATIVA: un código que no cabe a 7.5 mm se achica, nunca se corta; uno de 5 no', () => {
    expect(tamanoCodigo('TA011')).toBe('');
    expect(tamanoCodigo('RACK-12')).toBe('eu-c-m');
    expect(tamanoCodigo('PASILLO12')).toBe('eu-c-s');
  });

  it('NEGATIVA: el texto se escapa (un rótulo con < no rompe la hoja)', () => {
    expect(etiquetasUbicacionHtml([{ code: 'TA011', label: '<b>x', almacen: null }])).toContain('&lt;b&gt;x');
  });
});
