import { describe, expect, it } from 'vitest';
import { MM_POR_MODULO, modulosCode128 } from '@megadulces/ui-web';
import { CSS_ETIQUETA_UBICACION, GEOMETRIA_AMARILLA, PAGINA_TSC_AMARILLA, etiquetasUbicacionHtml, tamanoCodigo } from './etiqueta-ubicacion';

/**
 * `[UB.RF.14]` La etiqueta de ubicación de tienda en la TSC TE200, rollo amarillo. `[UB.RF.16]` Ese rollo es de
 * UNA etiqueta a lo ancho, de 55 × 25 mm medida con regla (Edgar, 2026-11-20). Kepler dice 60 × 30 y es falso;
 * la primera versión mandaba la fila de 3 de 32 × 48 del checado y la etiqueta salía de otro tamaño.
 */

const U = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `TA0${11 + i}`.slice(0, 5), label: 'Tienda · nivel 1', almacen: '01' }));

describe('[UB.RF.16] etiqueta de ubicación · TSC TE200 · rollo amarillo 55 × 25 (medido)', () => {
  it('⭐ una hoja de 55 × 25 mm por etiqueta: 7 ubicaciones = 7 etiquetas, sin filas', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(7)), 'text/html');
    expect(doc.querySelectorAll('.et').length).toBe(7);
    expect(doc.querySelector('.et-fila')).toBeNull();
    expect(PAGINA_TSC_AMARILLA).toBe('size: 55mm 25mm; margin: 0;');
    // 24.6 y no 25: con la etiqueta exacta a la hoja, el navegador mete una hoja en blanco.
    expect(CSS_ETIQUETA_UBICACION).toContain('width:55mm;height:24.6mm');
    expect(CSS_ETIQUETA_UBICACION).toContain('break-after:page');
  });

  it('cada etiqueta lleva su código grande, su CODE128 y arriba el almacén y el rótulo', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(1)), 'text/html');
    expect(doc.querySelector('.eu-code')?.textContent).toBe('TA011');
    expect(doc.querySelector('.eu-arriba')?.textContent).toBe('01 · Tienda · nivel 1');
    expect(doc.querySelector('svg.eu-bar')).not.toBeNull();
  });

  it('⭐ las barras van a 2 puntos de 203 dpi por módulo (0.25 mm) y dejan zona quieta de 10 módulos por lado', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(1)), 'text/html');
    const ancho = modulosCode128('TA011')! * MM_POR_MODULO;
    expect(doc.querySelector('svg.eu-bar')?.getAttribute('style')).toContain(`width:${ancho}mm`);
    const util = GEOMETRIA_AMARILLA.anchoMm - 2 * GEOMETRIA_AMARILLA.margenMm;
    expect((util - ancho) / 2).toBeGreaterThanOrEqual(10 * MM_POR_MODULO);
  });

  it('⭐ lo que va de arriba abajo cabe en los 24.6 mm (margen · rótulo · código · barras · margen), con aire', () => {
    const mm = (re: RegExp) => Number(re.exec(CSS_ETIQUETA_UBICACION)?.[1]);
    const alto = 2 * GEOMETRIA_AMARILLA.margenMm + mm(/\.eu-arriba\{[^}]*font-size:([\d.]+)mm/) * 1.1 + mm(/\.eu-code\{[^}]*font-size:([\d.]+)mm/) + mm(/\.eu-bar\{[^}]*height:([\d.]+)mm/);
    expect(alto).toBeLessThanOrEqual(GEOMETRIA_AMARILLA.altoMm - 0.4 - 2.5);
  });

  it('NEGATIVA: un código que no cabe a 9 mm se achica, nunca se corta; uno de 5 no', () => {
    expect(tamanoCodigo('TA011')).toBe('');
    expect(tamanoCodigo('RACK-12')).toBe('eu-c-m');
    expect(tamanoCodigo('PASILLO12')).toBe('eu-c-s');
  });

  it('NEGATIVA: el texto se escapa (un rótulo con < no rompe la hoja)', () => {
    expect(etiquetasUbicacionHtml([{ code: 'TA011', label: '<b>x', almacen: null }])).toContain('&lt;b&gt;x');
  });
});
