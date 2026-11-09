/**
 * `[RH.8.1]` El Resumen. Lo que se defiende: la ciudad sale de la regla del bot (y lo que no se reconoce va a «sin
 * ciudad», con su porqué), las etapas viejas caen en su vigente, y «fuera de meta» es la misma regla que la lista.
 */
import { HR_TALENT_SIN_CIUDAD } from '@megadulces/contracts';
import { ciudadDe, resumenReclutamiento } from './resumen';

const AHORA = new Date('2026-11-09T18:00:00Z');
const horasAntes = (h: number) => new Date(AHORA.getTime() - h * 3600000).toISOString();

describe('[RH.8.1] ciudadDe', () => {
  it('reconoce cómo escribe la gente; lo que nombra dos ciudades, no lo adivina', () => {
    expect(ciudadDe('Morelia, Michoacán')).toBe('Morelia');
    expect(ciudadDe('Padre Hidalgo (Santa Ana Pacueco, Gto.)')).toBe('Santa Ana Pacueco');
    expect(ciudadDe('8 Esquinas')).toBe('La Piedad');
    expect(ciudadDe('La Piedad o Santa Ana')).toBe(HR_TALENT_SIN_CIUDAD);
    expect(ciudadDe('marcos@correo.com')).toBe(HR_TALENT_SIN_CIUDAD);
  });
});

describe('[RH.8.1] resumenReclutamiento', () => {
  const r = resumenReclutamiento([
    { city_branch: 'Morelia', stage: null, desde: horasAntes(30) },              // filtro (meta 24 h): fuera
    { city_branch: 'En morelia', stage: 'filtro_inicial', desde: horasAntes(2) }, // dentro
    { city_branch: 'Zamora', stage: 'entrevista', desde: horasAntes(10) },        // vieja → entrevista_rh
    { city_branch: 'Canindo', stage: 'contratado', desde: horasAntes(9999) },     // desenlace: sin meta
    { city_branch: null, stage: 'aptitudes', desde: horasAntes(60) },             // sin ciudad (vacía), fuera (48 h)
    { city_branch: 'La Piedad o Santa Ana', stage: 'aptitudes', desde: horasAntes(1) },
    { city_branch: 'Yurécuaro', stage: 'aptitudes', desde: horasAntes(31 * 24) },     // rezago: no cuenta como «fuera de meta»
  ], AHORA);

  it('cuenta por ciudad y etapa, con la fila de «sin ciudad» y su porqué', () => {
    expect(r.total).toBe(7);
    const c = (n: string) => r.ciudades.find((x) => x.ciudad === n);
    expect(c('Morelia')?.por_etapa.filtro_inicial).toBe(2);
    expect(c('Zamora')?.por_etapa).toMatchObject({ entrevista_rh: 1, contratado: 1 });
    expect(c(HR_TALENT_SIN_CIUDAD)?.total).toBe(2);
    expect(r.sin_ciudad).toEqual({ vacia: 1, no_reconocida: 1 });
    expect(r.ciudades.reduce((t, x) => t + x.total, 0)).toBe(7);
  });

  it('rezago aparte; fuera de meta sólo entre los que se mueven; los desenlaces sin meta (null, no cero)', () => {
    const e = (n: string) => r.etapas.find((x) => x.etapa === n);
    expect(e('filtro_inicial')).toEqual({ etapa: 'filtro_inicial', total: 2, rezago: 0, fuera_de_meta: 1 });
    expect(e('aptitudes')).toEqual({ etapa: 'aptitudes', total: 3, rezago: 1, fuera_de_meta: 1 });
    expect(e('contratado')).toEqual({ etapa: 'contratado', total: 1, rezago: 0, fuera_de_meta: null });
    expect(r.rezago_dias).toBe(30);
  });
});
