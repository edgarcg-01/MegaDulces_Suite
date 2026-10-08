import {
  comidasPorHorario, DONDE_SE_CAPTURA_EL_VIATICO, erroresDeTarifaDeRuta, erroresDeTripulacion,
  erroresDeViaticos, horaAMinutos, tarifasDeViatico, viaticosDeLaGuia,
} from './viaticos-guia.contract';
import { DONDE_SE_CAPTURA_LA_TARIFA } from './nuevo-embarque.contract';

/**
 * `[EMB.19]` Los viáticos se CALCULAN del horario con la regla de la beta de Logística
 * (`aplicarSugerenciasHorario`) y las tarifas sembradas en `logistics_baseline.js`:
 * café 50 · desayuno 100 · comida 100 · cena 100.
 */

const TARIFAS = { cafe: 50, desayuno: 100, comida: 100, cena: 100 };
const SIN_TARIFAS = { cafe: 0, desayuno: 0, comida: 0, cena: 0 };
const SOLO_CHOFER = { driver: true, helper1: false, helper2: false };
const TRES = { driver: true, helper1: true, helper2: true };
const horario = (salida: string | null, llegada: string | null, duerme_fuera = false) => ({ salida, llegada, duerme_fuera });

describe('horaAMinutos', () => {
  it('lee HH:MM y el HH:MM:SS que devuelve Postgres', () => {
    expect(horaAMinutos('05:30')).toBe(330);
    expect(horaAMinutos('5:30')).toBe(330);
    expect(horaAMinutos('20:01:00')).toBe(1201);
  });
  it('lo que no es hora es null, no cero', () => {
    for (const h of [null, undefined, '', '24:00', '07:60', 'siete', '0730']) expect(horaAMinutos(h)).toBeNull();
  });
});

describe('comidasPorHorario — la regla de la beta, con sus bordes', () => {
  it('café y desayuno: sale ANTES de las 6:00 y de las 7:00 (a las 7:00 en punto ya no)', () => {
    expect(comidasPorHorario(horario('05:59', '12:00'))).toMatchObject({ cafe: true, desayuno: true });
    expect(comidasPorHorario(horario('06:00', '12:00'))).toMatchObject({ cafe: false, desayuno: true });
    expect(comidasPorHorario(horario('07:00', '12:00'))).toMatchObject({ cafe: false, desayuno: false });
  });
  it('comida: llega DESPUÉS de las 15:00; cena: después de las 20:00', () => {
    expect(comidasPorHorario(horario('08:00', '15:00'))).toMatchObject({ comida: false, cena: false });
    expect(comidasPorHorario(horario('08:00', '15:01'))).toMatchObject({ comida: true, cena: false });
    expect(comidasPorHorario(horario('08:00', '20:00'))).toMatchObject({ comida: true, cena: false });
    expect(comidasPorHorario(horario('08:00', '20:01'))).toMatchObject({ comida: true, cena: true });
  });
  it('si se queda a dormir hay cena aunque llegue temprano', () => {
    expect(comidasPorHorario(horario('08:00', '10:00', true))).toEqual({ cafe: false, desayuno: false, comida: false, cena: true });
  });
});

describe('viaticosDeLaGuia', () => {
  it('a cada persona que va le toca lo mismo; el que no va, nada', () => {
    const v = viaticosDeLaGuia(horario('05:30', '21:00'), TARIFAS, { driver: true, helper1: true, helper2: false });
    expect(v.driver).toEqual({ va: true, cafe: true, desayuno: true, comida: true, cena: true, subtotal: 350 });
    expect(v.helper1.subtotal).toBe(350);
    expect(v.helper2).toEqual({ va: false, cafe: false, desayuno: false, comida: false, cena: false, subtotal: 0 });
    expect(v.total).toBe(700);
  });
  it('guarda el horario y las tarifas con que se calculó (para auditarlo)', () => {
    const v = viaticosDeLaGuia(horario('6:15', '16:00:00'), TARIFAS, SOLO_CHOFER);
    expect(v.horario).toEqual({ salida: '06:15', llegada: '16:00', duerme_fuera: false });
    expect(v.tarifas).toEqual(TARIFAS);
    expect(v.regla).toBe('horario_beta');
    expect(v.total).toBe(200); // desayuno + comida
  });
  it('un horario sin comidas da cero, y eso SÍ es un cero real', () => {
    expect(viaticosDeLaGuia(horario('08:00', '14:00'), TARIFAS, TRES).total).toBe(0);
  });
  it('suma en centavos', () => {
    const t = { cafe: 0.1, desayuno: 0.2, comida: 0, cena: 0 };
    expect(viaticosDeLaGuia(horario('05:00', '12:00'), t, TRES).total).toBe(0.9);
  });
});

describe('erroresDeViaticos — sin hora o sin tarifa no se crea', () => {
  it('con horas y tarifas no frena', () => {
    expect(erroresDeViaticos(horario('05:30', '21:00'), TARIFAS)).toEqual([]);
  });
  it('pide las dos horas', () => {
    expect(erroresDeViaticos(horario(null, ''), TARIFAS)).toEqual(['Indica la hora de salida.', 'Indica la hora de llegada.']);
  });
  it('una hora mal escrita no se toma por vacía', () => {
    expect(erroresDeViaticos(horario('25:00', '12:00'), TARIFAS)[0]).toContain('no es válida');
  });
  it('frena si falta la tarifa de una comida QUE TOCA, y dice cuál y dónde se captura', () => {
    expect(erroresDeViaticos(horario('05:30', '12:00'), { ...TARIFAS, cafe: 0 }))
      .toEqual([`Falta la tarifa de café en ${DONDE_SE_CAPTURA_EL_VIATICO}.`]);
  });
  it('sin tarifas configuradas NO frena un horario que no da comidas', () => {
    expect(erroresDeViaticos(horario('08:00', '14:00'), SIN_TARIFAS)).toEqual([]);
  });
});

describe('tarifasDeViatico', () => {
  it('lee los renglones de config_finance e ignora lo que no es comida', () => {
    expect(tarifasDeViatico([
      { key: 'viatico_cafe', value: '50.00' }, { key: 'viatico_cena', value: 100 }, { key: 'viatico_hotel', value: 900 },
    ])).toEqual({ cafe: 50, desayuno: 0, comida: 0, cena: 100 });
  });
});

describe('erroresDeTarifaDeRuta — la comisión de una guía manual', () => {
  const ruta = { route_id: 'r1', nombre: 'RUTA PRUEBA', driver: 120, helper: 80 };
  it('con tarifa no frena', () => {
    expect(erroresDeTarifaDeRuta(ruta, { helper1: true, helper2: true })).toEqual([]);
  });
  it('sin ruta no hay comisión que calcular', () => {
    expect(erroresDeTarifaDeRuta(null, { helper1: false, helper2: false })).toEqual(['El embarque no tiene ruta: sin ruta no se calcula la comisión.']);
  });
  it('frena la tarifa de ayudante sólo si va un ayudante', () => {
    const sinAyudante = { ...ruta, helper: 0 };
    expect(erroresDeTarifaDeRuta(sinAyudante, { helper1: false, helper2: false })).toEqual([]);
    expect(erroresDeTarifaDeRuta(sinAyudante, { helper1: true, helper2: false }))
      .toEqual([`RUTA PRUEBA no tiene tarifa de ayudante en ${DONDE_SE_CAPTURA_LA_TARIFA}.`]);
  });
});

describe('erroresDeTripulacion', () => {
  it('pide chofer y no deja repetir personas', () => {
    expect(erroresDeTripulacion({ driver_id: null, helper1_id: null, helper2_id: null })).toEqual(['Elige al chofer.']);
    expect(erroresDeTripulacion({ driver_id: 'a', helper1_id: 'a', helper2_id: null })).toContain('El chofer no puede ir también como ayudante.');
    expect(erroresDeTripulacion({ driver_id: 'a', helper1_id: 'b', helper2_id: 'b' })).toContain('Ayudante 1 y ayudante 2 son la misma persona.');
    expect(erroresDeTripulacion({ driver_id: 'a', helper1_id: null, helper2_id: 'b' })).toContain('Captura primero al ayudante 1.');
  });
});
