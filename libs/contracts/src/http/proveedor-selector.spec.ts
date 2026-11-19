import { textoUltimoMovimiento } from './proveedor-selector.contract';

/**
 * `[PGP.146]` / `[PGP.148.2]` El texto que distingue a dos proveedores con el mismo nombre (VUMERSOFT `CD004`,
 * 613 documentos, contra `CV10`, ninguno). Lo usan «Cuentas de pago» y el diálogo del anticipo: una sola regla.
 */
describe('textoUltimoMovimiento', () => {
  it('con fecha: «último movimiento 9-nov-2026»', () => {
    expect(textoUltimoMovimiento('2026-11-09')).toBe('último movimiento 9-nov-2026');
  });
  it('null = cero documentos en Kepler, y se dice', () => {
    expect(textoUltimoMovimiento(null)).toBe('sin movimientos en Kepler');
  });
  it('⛔ NEGATIVA — undefined (la respuesta no lo trajo) no se dibuja como «sin movimientos»: no se midió', () => {
    expect(textoUltimoMovimiento(undefined)).toBeNull();
  });
});
