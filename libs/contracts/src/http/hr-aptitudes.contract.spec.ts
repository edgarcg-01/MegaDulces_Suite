/**
 * `[RH.2.4]` La evaluación de aptitudes (formato STAR de Mega Talento): 5 / 8 / 10 puntos y bandas por porcentaje.
 */
import { HR_APTITUDES_APROBADO_PCT, hrBandaStar, hrPuntajeStar, type HrCompetenciaStar } from './hr-aptitudes.contract';

const comp = (key: string): HrCompetenciaStar => ({ key, categoria: 'x', parametro: key, preguntaStar: '?', anclas: { inferior: 'i', cumple: 'c', supera: 's' } });
const QUINCE = Array.from({ length: 15 }, (_, i) => comp(`c${i}`));

describe('[RH.2.4] evaluación de aptitudes (STAR)', () => {
  it('15 competencias: todo «supera» = 150/150; todo «inferior» = 75/150', () => {
    const todas = (n: 'inferior' | 'supera') => Object.fromEntries(QUINCE.map((c) => [c.key, n]));
    expect(hrPuntajeStar(todas('supera'), QUINCE)).toMatchObject({ puntaje: 150, max: 150, pct: 100, banda: 'Altamente Recomendable', completa: true });
    expect(hrPuntajeStar(todas('inferior'), QUINCE)).toMatchObject({ puntaje: 75, pct: 50, banda: 'No Recomendable' });
  });

  it('las bandas son las de /150 en porcentaje (135 = 90, 115 ≈ 76.7, 90 = 60)', () => {
    expect(hrBandaStar(90)).toBe('Altamente Recomendable');
    expect(hrBandaStar(77)).toBe('Recomendable');
    expect(hrBandaStar(76)).toBe('Recomendable con Reservas');
    expect(hrBandaStar(60)).toBe('Recomendable con Reservas');
    expect(hrBandaStar(59)).toBe('No Recomendable');
    expect(HR_APTITUDES_APROBADO_PCT).toBeCloseTo(76.667);
  });

  it('⛔ NEGATIVA — incompleta no está completa, y un nivel inventado no cuenta', () => {
    const r = hrPuntajeStar({ c0: 'supera', c1: 'excelente' as never }, QUINCE);
    expect([r.calificadas, r.completa, r.puntaje]).toEqual([1, false, 10]);
    expect(hrPuntajeStar({}, []).completa).toBe(false);
  });
});
