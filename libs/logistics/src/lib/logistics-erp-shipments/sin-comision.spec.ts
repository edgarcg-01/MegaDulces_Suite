import { comisionSugerida } from './nuevo-embarque.logic';
import { comisionesDeLaGuia, erroresDeTarifa, erroresDeTarifaDeRuta } from '@megadulces/contracts';

/**
 * `[EMB.33]` Rutas que no pagan comisión (traslados locales: Santa Ana Pacueco, Santa Ana, La
 * Piedad). Medido en prod: el chofer de CEDIS con 93 viajes cobró $954 (~$10/viaje) y los que sólo
 * van a Santa Ana Pacueco no cobran comisión. La guía tiene que poder completarse en $0.
 */

const CATALOGO = [
  { id: 'r-pac', name: 'SANTA ANA PACUECO', kepler_code: 'R0024', driver_commission: '0.00', helper_commission: '0.00', sin_comision: true },
  { id: 'r-zam', name: 'CANINDO ZAMORA', kepler_code: null, driver_commission: '180.00', helper_commission: '120.00', sin_comision: false },
  { id: 'r-cero', name: 'ARANDAS', kepler_code: null, driver_commission: '0.00', helper_commission: '0.00', sin_comision: false },
];
const AY = { helper1: true, helper2: false };

describe('comisionSugerida con rutas sin comisión', () => {
  it('un viaje sólo local: emparejado en $0, sin «falta tarifa», y la guía se completa en $0', () => {
    const c = comisionSugerida([{ clave: 'R0024', nombre: 'SANTA ANA PACUECO' }], CATALOGO);
    expect(c.sin_tarifa).toEqual([]);
    expect(c.sin_comision).toBe(true);
    expect(c.emparejadas[0]).toMatchObject({ route_id: 'r-pac', driver: 0, helper: 0, sin_comision: true });
    expect(erroresDeTarifa(c, 0, AY)).toEqual([]);
    expect(comisionesDeLaGuia(c, AY)).toEqual({ driver_commission: 0, helper1_commission: 0, helper2_commission: 0 });
  });

  it('local + una ruta con tarifa: paga la tarifa de la otra (la mayor del viaje)', () => {
    const c = comisionSugerida([{ clave: 'R0024', nombre: 'SANTA ANA PACUECO' }, { clave: 'R0037', nombre: 'CANINDO ZAMORA' }], CATALOGO);
    expect(c.sin_comision).toBe(false);
    expect(c).toMatchObject({ driver: 180, helper: 120 });
    expect(erroresDeTarifa(c, 0, AY)).toEqual([]);
  });

  it('PRUEBA NEGATIVA: una ruta en $0 SIN la marca sigue frenando la guía', () => {
    const c = comisionSugerida([{ clave: 'R0029', nombre: 'ARANDAS' }], CATALOGO);
    expect(c.sin_comision).toBe(false);
    expect(erroresDeTarifa(c, 0, AY)[0]).toContain('Falta la tarifa de ARANDAS');
  });

  it('PRUEBA NEGATIVA: local + una ruta sin tarifa sigue frenando (la que falta podría ser la mayor)', () => {
    const c = comisionSugerida([{ clave: 'R0024', nombre: 'SANTA ANA PACUECO' }, { clave: 'R0029', nombre: 'ARANDAS' }], CATALOGO);
    expect(c.sin_comision).toBe(false);
    expect(erroresDeTarifa(c, 0, AY)[0]).toContain('ARANDAS');
  });

  it('guía manual: una ruta sin comisión no pide tarifa; en $0 sin marca, sí', () => {
    expect(erroresDeTarifaDeRuta({ route_id: 'r', nombre: 'LA PIEDAD', driver: 0, helper: 0, sin_comision: true }, AY)).toEqual([]);
    expect(erroresDeTarifaDeRuta({ route_id: 'r', nombre: 'ARANDAS', driver: 0, helper: 0 }, AY).length).toBeGreaterThan(0);
  });
});
