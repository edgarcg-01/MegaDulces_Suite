import { comisionesDeLaGuia, DONDE_SE_CAPTURA_LA_TARIFA, erroresDeTarifa } from './nuevo-embarque.contract';

/**
 * `[EMB.12]` La comisión del viaje se CALCULA (fórmula de la beta de Logística) y lo que impide
 * calcularla frena el embarque. Casos con la guía 06-G0001419 de Canindo: cruza 4 rutas, la mayor
 * tarifa es JIQUILPAN (98.04 / 57.76) y SANTAGIO TANGAMNADAPIO no tiene tarifa en el catálogo.
 */

const JIQUILPAN = { clave: 'R0057', nombre: 'JIQUILPAN', route_id: 'r57' };
const conTarifa = { driver: 98.04, helper: 57.76, ruta_usada: JIQUILPAN, sin_tarifa: [] };
const sinAyudantes = { helper1: false, helper2: false };

describe('comisionesDeLaGuia — la fórmula de la beta', () => {
  it('chofer = tarifa de chofer de la ruta; cada ayudante que va = tarifa de ayudante', () => {
    expect(comisionesDeLaGuia(conTarifa, { helper1: true, helper2: true }))
      .toEqual({ driver_commission: 98.04, helper1_commission: 57.76, helper2_commission: 57.76 });
  });

  it('un ayudante que no va no cobra', () => {
    expect(comisionesDeLaGuia(conTarifa, { helper1: true, helper2: false }))
      .toEqual({ driver_commission: 98.04, helper1_commission: 57.76, helper2_commission: 0 });
    expect(comisionesDeLaGuia(conTarifa, sinAyudantes))
      .toEqual({ driver_commission: 98.04, helper1_commission: 0, helper2_commission: 0 });
  });
});

describe('erroresDeTarifa — sin tarifa no se crea', () => {
  it('con tarifa en todas las rutas no frena', () => {
    expect(erroresDeTarifa(conTarifa, 0, { helper1: true, helper2: false })).toEqual([]);
  });

  it('una ruta sin tarifa frena AUNQUE otra del viaje la tenga, y dice dónde capturarla', () => {
    const e = erroresDeTarifa({ ...conTarifa, sin_tarifa: [{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }] }, 0, sinAyudantes);
    expect(e).toEqual([`Falta la tarifa de SANTAGIO TANGAMNADAPIO en ${DONDE_SE_CAPTURA_LA_TARIFA}.`]);
  });

  it('nombra todas las que faltan; si Kepler no trae nombre, la clave', () => {
    const e = erroresDeTarifa({ ...conTarifa, sin_tarifa: [{ clave: 'R0024', nombre: 'SANTA ANA PACUECO' }, { clave: 'R0099', nombre: null }] }, 0, sinAyudantes);
    expect(e[0]).toContain('SANTA ANA PACUECO, R0099');
  });

  it('una parada sin ruta en Kepler frena: sin ruta no hay tarifa que aplicar', () => {
    expect(erroresDeTarifa(conTarifa, 1, sinAyudantes)[0]).toMatch(/^Una parada no tiene ruta en Kepler/);
    expect(erroresDeTarifa(conTarifa, 3, sinAyudantes)[0]).toMatch(/^3 paradas no tienen ruta en Kepler/);
  });

  it('una ruta con tarifa de chofer pero sin la de ayudante frena SÓLO si va ayudante', () => {
    const sinAyud = { ...conTarifa, helper: 0 };
    expect(erroresDeTarifa(sinAyud, 0, sinAyudantes)).toEqual([]);
    expect(erroresDeTarifa(sinAyud, 0, { helper1: true, helper2: false }))
      .toEqual([`JIQUILPAN no tiene tarifa de ayudante en ${DONDE_SE_CAPTURA_LA_TARIFA}.`]);
  });

  it('sin rutas en el viaje (nada que emparejar) frena', () => {
    expect(erroresDeTarifa({ driver: null, helper: null, ruta_usada: null, sin_tarifa: [] }, 0, sinAyudantes))
      .toEqual(['El viaje no tiene ruta en Kepler: sin ruta no se calcula la comisión.']);
  });
});
