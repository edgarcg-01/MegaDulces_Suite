import { SD_UBICACIONES_EXTRA } from '@megadulces/contracts';
import { nombreUbicacionExtra, ubicacionExtra } from './ubicaciones';

/**
 * `[MS.3.14]` Las ubicaciones que no son sucursal (oficinas corporativas). Lo que se defiende: se acepta y se nombra,
 * sin distinguir mayúsculas; y **no se relaja nada** de lo que ya se rechazaba (los códigos de Kepler y las eras de
 * Wincaja no pasan por aquí).
 */
describe('MS.3.14 · ubicaciones que no son sucursal', () => {
  it('⭐ «OF» son las Oficinas Corporativas', () => {
    expect(SD_UBICACIONES_EXTRA['OF']).toBe('Oficinas Corporativas');
    expect(ubicacionExtra('OF')).toBe('OF');
    expect(nombreUbicacionExtra('OF')).toBe('Oficinas Corporativas');
  });
  it('se acepta sin distinguir mayúsculas ni espacios, y se guarda en el código canónico', () => {
    expect(ubicacionExtra('of')).toBe('OF');
    expect(ubicacionExtra('  Of ')).toBe('OF');
    expect(nombreUbicacionExtra('of')).toBe('Oficinas Corporativas');
  });
  it('⛔ NEGATIVA — lo que no es una ubicación extra NO lo es: sucursales Kepler, eras de Wincaja, basura', () => {
    for (const c of ['00', '01', '08', '30', '32', '50', 'XX', 'OFI', 'O', '', '  ']) {
      expect(ubicacionExtra(c), `«${c}»`).toBeNull();
      expect(nombreUbicacionExtra(c), `«${c}»`).toBeNull();
    }
    expect(ubicacionExtra(null)).toBeNull();
    expect(ubicacionExtra(undefined)).toBeNull();
  });
  it('⛔ NEGATIVA — no hereda propiedades del prototipo («constructor», «toString» no son ubicaciones)', () => {
    expect(ubicacionExtra('constructor')).toBeNull();
    expect(ubicacionExtra('toString')).toBeNull();
    expect(ubicacionExtra('__proto__')).toBeNull();
  });
  it('un código extra NUNCA puede chocar con uno de Kepler (letras contra dos dígitos)', () => {
    for (const code of Object.keys(SD_UBICACIONES_EXTRA)) expect(code).not.toMatch(/^[0-9]{2}$/);
  });
  it('el catálogo es inmutable (nadie le agrega una ubicación en tiempo de ejecución)', () => {
    expect(Object.isFrozen(SD_UBICACIONES_EXTRA)).toBe(true);
  });
});
