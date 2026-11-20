import { describe, it, expect } from 'vitest';
import { etiquetaSemana, fechaAIso, isoAFecha, semanaDe } from './semana-picker.component';

/**
 * `[PGP.176]` Candado de la semana que dice la etiqueta. Tiene que ser la MISMA que arma el servidor
 * (`weekDates()` en `payment-calendar.service.ts`: lunes a domingo): si difieren, la etiqueta dice una
 * semana y la tira enseña otra.
 */
describe('semanaDe — lunes a domingo, como el servidor', () => {
  it('un viernes cae en la semana de su lunes', () => {
    expect(semanaDe('2026-11-20')).toEqual({ desde: '2026-11-16', hasta: '2026-11-22' });
  });

  it('el domingo es el ÚLTIMO día de su semana, no el primero de la siguiente', () => {
    expect(semanaDe('2026-11-22')).toEqual({ desde: '2026-11-16', hasta: '2026-11-22' });
  });

  it('el lunes abre su propia semana', () => {
    expect(semanaDe('2026-11-16')).toEqual({ desde: '2026-11-16', hasta: '2026-11-22' });
  });

  it('el brinco medido: del 15-oct (semana 12–18) al 23-dic (semana 21–27)', () => {
    expect(semanaDe('2026-10-15')).toEqual({ desde: '2026-10-12', hasta: '2026-10-18' });
    expect(semanaDe('2026-12-23')).toEqual({ desde: '2026-12-21', hasta: '2026-12-27' });
  });

  it('la semana que cruza el año', () => {
    expect(semanaDe('2026-12-31')).toEqual({ desde: '2026-12-28', hasta: '2027-01-03' });
    expect(semanaDe('2027-01-03')).toEqual({ desde: '2026-12-28', hasta: '2027-01-03' });
  });
});

describe('etiquetaSemana — la forma que ya tenía la pantalla', () => {
  it('«16 nov – 22 nov 2026»', () => {
    expect(etiquetaSemana('2026-11-20')).toBe('16 nov – 22 nov 2026');
  });

  it('el año va al final, el del domingo', () => {
    expect(etiquetaSemana('2026-12-30')).toBe('28 dic – 3 ene 2027');
  });
});

describe('isoAFecha / fechaAIso — el calendario trabaja en hora local', () => {
  it('ida y vuelta sin mover el día', () => {
    for (const iso of ['2026-01-01', '2026-04-05', '2026-10-25', '2026-12-31', '2028-02-29']) {
      expect(fechaAIso(isoAFecha(iso))).toBe(iso);
    }
  });

  it('el día que toca la persona en el calendario (medianoche local) es ese día', () => {
    expect(fechaAIso(new Date(2026, 11, 23))).toBe('2026-12-23');
  });
});
