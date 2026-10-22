import { factorBaseDe } from './autoabasto-pedido.service';

/**
 * `[AB.23]` La conversión a unidad BASE de lo pedido y lo embarcado. Antes se asumía que `kdm2.c9`
 * venía en base; medido el 2026-10-22, 44 renglones de pedidos de traspaso en 30 días venían en CAJAS.
 * El SQL (que no corre un doble de Knex) lo prueba `database/tests/test-newdb-autoabasto-en-camino.js`.
 */
const ESC = { unit_base: 'PAQ', u2_label: 'PAQ', u3_label: 'CJA', f2: 1, f3: 16, is_weight: false };

describe('factorBaseDe', () => {
  it('la base cuenta 1 y la caja cuenta lo que trae', () => {
    expect(factorBaseDe('PAQ', ESC)).toBe(1);
    expect(factorBaseDe('cja', ESC)).toBe(16);
  });
  it('CONTROL: 2 cajas pedidas son 32 paquetes, no 2 (el defecto de antes)', () => {
    expect(2 * factorBaseDe('CJA', ESC)!).toBe(32);
  });
  it('⛔ una unidad que la escalera no conoce no se adivina', () => {
    expect(factorBaseDe('500', ESC)).toBeNull();
  });
  it('la base con rótulo de gramaje (500) llega sin nombre y cuenta 1: 02972 OREO, $47.79 = costo base', () => {
    const oreo = { unit_base: null, u2_label: 'KG', u3_label: 'CJA', f2: 2, f3: 18, is_weight: true };
    expect(factorBaseDe('500', oreo)).toBe(1);
    expect(factorBaseDe('KG', oreo)).toBe(2);
    expect(factorBaseDe('PZA', oreo)).toBeNull();   // NEGATIVA: un rótulo que no es gramaje sigue sin adivinarse
  });
  it('sin escalera se toma la base, como antes (no restar nada sería peor)', () => {
    expect(factorBaseDe('PZA', null)).toBe(1);
  });
  it('sin unidad en el renglón, la base', () => {
    expect(factorBaseDe(null, ESC)).toBe(1);
  });
});
