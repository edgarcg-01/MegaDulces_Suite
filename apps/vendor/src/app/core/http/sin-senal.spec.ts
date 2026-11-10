import { esSinSenal } from './sin-senal';

/**
 * `[VTK.16]` Sin señal no es «el servidor no lo aceptó». El caso que lo originó: en el navegador del
 * celular el service worker contesta 504 sin cuerpo cuando la red falla.
 */
describe('esSinSenal', () => {
  it('el 504 sin cuerpo del service worker es sin señal (el caso de la prueba de David)', () => {
    expect(esSinSenal({ status: 504, error: '' }, true)).toBe(true);
    expect(esSinSenal({ status: 504, error: null }, true)).toBe(true);
    expect(esSinSenal({ status: 504, error: '<html>Gateway Timeout</html>' }, true)).toBe(true);
  });

  it('status 0 (app instalada) y el teléfono sin red también', () => {
    expect(esSinSenal({ status: 0 }, true)).toBe(true);
    expect(esSinSenal({ status: 500, error: { message: 'x' } }, false)).toBe(true);
  });

  it('NEGATIVO: lo que el servidor sí contestó NO es sin señal', () => {
    expect(esSinSenal({ status: 500, error: {} }, true)).toBe(false);
    expect(esSinSenal({ status: 400, error: { message: ['cantidad inválida'] } }, true)).toBe(false);
    expect(esSinSenal({ status: 504, error: { message: 'Kepler no contestó a tiempo' } }, true)).toBe(false);
    expect(esSinSenal({ status: 403 }, true)).toBe(false);
    expect(esSinSenal(null, true)).toBe(false);
  });
});
