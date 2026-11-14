import { describe, it, expect } from 'vitest';
import { puedeIncrustarPdf } from './pdf-inline';

/**
 * `[GX.112]` En táctil un PDF no se incrusta (el WebView no lo pinta): se abre en el visor nativo.
 */
describe('[GX.112] puedeIncrustarPdf — el puntero decide', () => {
  it('⭐ puntero FINO (escritorio): se incrusta', () => {
    expect(puedeIncrustarPdf((q) => ({ matches: q === '(pointer: coarse)' ? false : false }))).toBe(true);
  });

  it('⛔ NEGATIVA: puntero GRUESO (táctil): NO se incrusta — se abre aparte', () => {
    expect(puedeIncrustarPdf((q) => ({ matches: q === '(pointer: coarse)' }))).toBe(false);
  });

  it('sin matchMedia (SSR/jsdom): se asume escritorio, se incrusta', () => {
    expect(puedeIncrustarPdf(null)).toBe(true);
  });

  it('si matchMedia lanza, no rompe: se incrusta', () => {
    expect(puedeIncrustarPdf(() => { throw new Error('boom'); })).toBe(true);
  });
});
