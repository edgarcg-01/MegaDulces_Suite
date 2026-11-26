import { describe, expect, it } from 'vitest';
import { MM_POR_MODULO, modulosCode128 } from '@megadulces/ui-web';
import {
  ROLLOS_AMARILLOS,
  ROLLO_POR_OMISION,
  anchoUtilMm,
  cssEtiquetaUbicacion,
  etiquetasUbicacionHtml,
  paginaTscAmarilla,
  tamanoCodigo,
  type RolloAmarillo,
} from './etiqueta-ubicacion';

/**
 * `[UB.RF.14]` La etiqueta de ubicación de tienda en la TSC TE200, rollo amarillo. `[UB.RF.16]` Ese rollo era
 * de 55 × 25 mm medido con regla (Edgar, 2026-11-20) — Kepler dice 60 × 30 y es falso, y la primera versión
 * mandaba la fila de 3 de 32 × 48 del checado.
 *
 * `[UB.RF.20]` Ahora hay **DOS rollos y conviven** (Edgar, 2026-11-25): 55 × 25 y 60 × 29, los dos medidos con
 * regla. Por eso cada prueba de geometría corre **para los dos**: una medida que sólo se comprueba en uno es
 * media compuerta, y la etiqueta sale de una impresora que nadie mira hasta que el papel ya se gastó.
 */

const U = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `TA0${11 + i}`.slice(0, 5), label: 'Tienda · nivel 1', almacen: '01' }));
const ROLLOS = Object.keys(ROLLOS_AMARILLOS) as RolloAmarillo[];

describe('[UB.RF.20] etiqueta de ubicación · los dos rollos amarillos', () => {
  it('⭐ son dos, y el de siempre sigue siendo el de omisión (nadie cambia de papel sin pedirlo)', () => {
    expect(ROLLOS).toEqual(['55x25', '60x29']);
    expect(ROLLO_POR_OMISION).toBe('55x25');
  });

  it('⭐ cada rollo manda SU tamaño de hoja a la impresora', () => {
    expect(paginaTscAmarilla('55x25')).toBe('size: 55mm 25mm; margin: 0;');
    expect(paginaTscAmarilla('60x29')).toBe('size: 60mm 29mm; margin: 0;');
  });

  it('⛔ NEGATIVA: el rollo grande NO imprime con la medida del chico (el defecto que se busca evitar)', () => {
    expect(paginaTscAmarilla('60x29')).not.toContain('55mm');
    expect(cssEtiquetaUbicacion('60x29')).not.toContain('width:55mm');
  });

  describe.each(ROLLOS)('rollo %s', (rollo) => {
    const r = ROLLOS_AMARILLOS[rollo];
    const css = cssEtiquetaUbicacion(rollo);

    it('una hoja por etiqueta: 7 ubicaciones = 7 etiquetas, sin filas', () => {
      const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(7)), 'text/html');
      expect(doc.querySelectorAll('.et').length).toBe(7);
      expect(doc.querySelector('.et-fila')).toBeNull();
      expect(css).toContain('break-after:page');
    });

    it('⭐ la etiqueta se dibuja 0.4 mm más baja que la hoja (si no, el navegador mete una hoja en blanco)', () => {
      expect(r.etiquetaAltoMm).toBe(Math.round((r.altoMm - 0.4) * 10) / 10);
      expect(css).toContain(`width:${r.anchoMm}mm;height:${r.etiquetaAltoMm}mm`);
    });

    it('⭐ las barras van a 2 puntos de 203 dpi por módulo y dejan zona quieta de 10 módulos por lado', () => {
      const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(1)), 'text/html');
      const ancho = modulosCode128('TA011')! * MM_POR_MODULO;
      expect(doc.querySelector('svg.eu-bar')?.getAttribute('style')).toContain(`width:${ancho}mm`);
      expect((anchoUtilMm(rollo) - ancho) / 2).toBeGreaterThanOrEqual(10 * MM_POR_MODULO);
    });

    it('⭐ lo que va de arriba abajo CABE, con aire: margen · rótulo · código · barras · margen', () => {
      const mm = (re: RegExp) => Number(re.exec(css)?.[1]);
      const alto = 2 * r.margenMm + mm(/\.eu-arriba\{[^}]*font-size:([\d.]+)mm/) * 1.1 + mm(/\.eu-code\{[^}]*font-size:([\d.]+)mm/) + mm(/\.eu-bar\{[^}]*height:([\d.]+)mm/);
      expect(alto).toBeLessThanOrEqual(r.etiquetaAltoMm - 2.5);
    });

    it('las barras nunca pasan del ancho útil del papel', () => {
      expect(css).toContain(`max-width:${anchoUtilMm(rollo)}mm`);
      expect(anchoUtilMm(rollo)).toBe(r.anchoMm - 2 * r.margenMm);
    });
  });

  it('⭐ el rollo grande aprovecha el espacio: código y barras MÁS grandes, no la misma etiqueta estirada', () => {
    const chico = ROLLOS_AMARILLOS['55x25'];
    const grande = ROLLOS_AMARILLOS['60x29'];
    expect(grande.codigoMm).toBeGreaterThan(chico.codigoMm);
    expect(grande.barrasAltoMm).toBeGreaterThan(chico.barrasAltoMm);
    expect(anchoUtilMm('60x29')).toBeGreaterThan(anchoUtilMm('55x25'));
  });

  it('cada etiqueta lleva su código grande, su CODE128 y arriba el almacén y el rótulo', () => {
    const doc = new DOMParser().parseFromString(etiquetasUbicacionHtml(U(1)), 'text/html');
    expect(doc.querySelector('.eu-code')?.textContent).toBe('TA011');
    expect(doc.querySelector('.eu-arriba')?.textContent).toBe('01 · Tienda · nivel 1');
    expect(doc.querySelector('svg.eu-bar')).not.toBeNull();
  });

  it('NEGATIVA: un código que no cabe se achica, nunca se corta; uno de 5 no', () => {
    expect(tamanoCodigo('TA011')).toBe('');
    expect(tamanoCodigo('RACK-12')).toBe('eu-c-m');
    expect(tamanoCodigo('PASILLO12')).toBe('eu-c-s');
  });

  it('NEGATIVA: el texto se escapa (un rótulo con < no rompe la hoja)', () => {
    expect(etiquetasUbicacionHtml([{ code: 'TA011', label: '<b>x', almacen: null }])).toContain('&lt;b&gt;x');
  });
});
