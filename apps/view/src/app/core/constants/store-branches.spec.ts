import { branchLabel, branchName } from './store-branches';

/** `[GX.68]` La sucursal del vale se nombra con clave + nombre. */
describe('branchLabel', () => {
  it('pone la clave delante del nombre', () => {
    expect(branchLabel('00')).toBe('00 CEDIS');
    expect(branchLabel('02')).toBe('02 La Piedad Abastos');
    expect(branchLabel('03')).toBe('03 8 Esquinas');
    expect(branchLabel('08')).toBe('08 Morelia Abastos');
  });

  it('cubre las 9 sucursales de la red, 00 a 08', () => {
    for (let i = 0; i <= 8; i++) {
      const c = `0${i}`;
      expect(branchLabel(c)).not.toBe(c);
    }
  });

  it('una clave desconocida sale sola, sin inventar nombre', () => {
    expect(branchLabel('99')).toBe('99');
  });

  it('sin clave devuelve vacío, para que la plantilla ponga su guion', () => {
    expect(branchLabel(null)).toBe('');
    expect(branchLabel('  ')).toBe('');
  });

  it('tolera espacios alrededor de la clave', () => {
    expect(branchLabel(' 05 ')).toBe('05 Zamora Centro');
  });

  it('branchName sigue devolviendo sólo el nombre', () => {
    expect(branchName('02')).toBe('La Piedad Abastos');
  });
});
