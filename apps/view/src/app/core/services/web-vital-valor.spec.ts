import { CLS_UMBRAL_POOR, valorWebVital, WEB_VITALS_SIN_UNIDAD } from './web-vital-valor';

/**
 * `[RA-PERF.5]` — el candado del redondeo por unidad.
 *
 * Las muestras de abajo NO son inventadas: son el rango real medido en prod el 2026-10-07 sobre
 * `commercial.portal_telemetry_events` (795 muestras de CLS, 52 de INP y 24 de LCP de
 * `/compras/pedido`). El bug no se descubrió viendo el código: se descubrió viendo un `value: 0`
 * al lado de un `rating: 'poor'`.
 */
describe('[RA-PERF.5] valorWebVital — la unidad decide el redondeo', () => {
  describe('CLS es un score sin unidad: NO se redondea a entero', () => {
    // ⛔ PRUEBA NEGATIVA. Éstos son los casos que el código anterior (`Math.round(m.value)`)
    // archivaba como 0. Si alguien vuelve a redondear a entero, estas tres se ponen en rojo.
    it.each([
      [0.312, 'poor'],
      [0.25, 'el umbral exacto de poor'],
      [0.1, 'el umbral exacto de needs-improvement'],
      [0.014, 'good pero no cero'],
    ])('CLS %p (%s) se conserva, no se archiva como 0', (valor) => {
      expect(valorWebVital('CLS', valor)).toBe(valor);
      expect(Math.round(valor)).toBe(0);   // lo que hacía antes, escrito para que se vea
    });

    it('un CLS malo NUNCA sale igual que un CLS perfecto', () => {
      expect(valorWebVital('CLS', CLS_UMBRAL_POOR + 0.06)).not.toBe(valorWebVital('CLS', 0));
    });

    it('un cero de verdad sigue siendo cero (no se inventa precisión)', () => {
      expect(valorWebVital('CLS', 0)).toBe(0);
    });

    it('se corta en 3 decimales: el ruido por debajo del umbral no se guarda', () => {
      expect(valorWebVital('CLS', 0.1234567)).toBe(0.123);
    });

    it('un CLS grande (los hubo: valor 1 en prod) pasa entero', () => {
      expect(valorWebVital('CLS', 1)).toBe(1);
    });
  });

  describe('INP y LCP son milisegundos: el entero ES la precisión útil', () => {
    it('INP 112.6 ms → 113', () => expect(valorWebVital('INP', 112.6)).toBe(113));
    it('LCP 1356.4 ms → 1356', () => expect(valorWebVital('LCP', 1356.4)).toBe(1356));
    it('un INP sub-milisegundo no se infla con decimales falsos', () => {
      expect(valorWebVital('INP', 0.4)).toBe(0);
    });
  });

  describe('el conjunto de métricas sin unidad es la única perilla', () => {
    it('hoy sólo CLS', () => expect([...WEB_VITALS_SIN_UNIDAD]).toEqual(['CLS']));
    it('una métrica desconocida se trata como milisegundos (el caso común)', () => {
      expect(valorWebVital('TTFB', 87.9)).toBe(88);
    });
  });
});
