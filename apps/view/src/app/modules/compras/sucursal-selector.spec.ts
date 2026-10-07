import { ofrecerSelectorSucursal } from './sucursal-selector';

/**
 * La prueba NEGATIVA de la regla: sin el primer `if`, el caso que reportó el usuario se pone
 * rojo. Si alguien "simplifica" la función a `visibles.length > 1`, estos tres casos caen.
 */
describe('ofrecerSelectorSucursal — un control que aplicó un filtro no puede desaparecer', () => {
  describe('⛔ el defecto reportado: elegir una sucursal escondía el control', () => {
    it('con una sucursal elegida SIEMPRE se ofrece, aunque el alcance traiga una sola', () => {
      // Esto es exactamente lo que devolvía el backend al filtrar: la lista ya recortada.
      expect(ofrecerSelectorSucursal(['30'], '30')).toBe(true);
    });

    it('sigue ofreciéndose aunque el alcance venga VACÍO', () => {
      // Caso feo pero posible: el servidor no devolvió lista y el filtro está puesto. Esconder
      // el control acá deja a la persona sin forma de volver.
      expect(ofrecerSelectorSucursal([], '30')).toBe(true);
    });

    it('y aunque la elegida ni siquiera esté en la lista visible', () => {
      // Pasa con un link pegado: `?suc=00` de alguien con más alcance. El filtro no devuelve
      // nada y hay que poder soltarlo.
      expect(ofrecerSelectorSucursal(['30', '32'], '00')).toBe(true);
    });
  });

  describe('sin filtro puesto, la regla vieja se conserva', () => {
    it('una sola sucursal visible: el selector no decide nada, no se ofrece', () => {
      expect(ofrecerSelectorSucursal(['30'], null)).toBe(false);
    });

    it('ninguna visible: tampoco', () => {
      expect(ofrecerSelectorSucursal([], null)).toBe(false);
    });

    it('dos o más: se ofrece', () => {
      expect(ofrecerSelectorSucursal(['30', '32'], null)).toBe(true);
    });
  });

  describe('`null` no es "ninguna" — es "el servidor no acotó"', () => {
    it('alcance de red (null): se ofrece, y las opciones salen del catálogo', () => {
      expect(ofrecerSelectorSucursal(null, null)).toBe(true);
    });

    it('undefined (el reporte todavía no cargó) se trata igual', () => {
      expect(ofrecerSelectorSucursal(undefined, null)).toBe(true);
    });
  });

  describe('la cadena vacía NO es una sucursal elegida', () => {
    it('`\'\'` no cuenta como filtro: con una sola visible, no se ofrece', () => {
      // El `?suc=` vacío de una URL mal armada no debe forzar un control inútil.
      expect(ofrecerSelectorSucursal(['30'], '')).toBe(false);
    });
  });
});
