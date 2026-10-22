/**
 * `[CGA-A.44]` — Pruebas de «qué ya saldó el Control» y de las fechas del relevo.
 *
 * Lo que importa probar es que la cola y el Cuadre casen IGUAL: si la cola diera por saldado algo
 * que el Cuadre no, ese documento desaparecería de las dos pantallas sin que nadie lo hubiera
 * capturado. Por eso las negativas.
 */
import { casadosPorControl, diaAnterior, inicioDelMes, type MovDelDia } from './caja-relevo';
import { CUADRE_TOLERANCIA_PESOS } from './caja-cuadre.engine';

const c = (key: string, importe: number, fecha: string, dir: 'in' | 'out' = 'in'): MovDelDia => ({ key, importe, fecha, dir });

describe('fechas del relevo', () => {
  it('inicio del mes y día anterior, también cruzando mes', () => {
    expect(inicioDelMes('2026-10-12')).toBe('2026-10-01');
    expect(diaAnterior('2026-10-12')).toBe('2026-10-11');
    expect(diaAnterior('2026-11-01')).toBe('2026-10-31');
  });
});

describe('casadosPorControl', () => {
  it('casa con el Control del MISMO día y dirección, dentro de la tolerancia', () => {
    // Caso real: 01-002 U-A-5 0000003 $26,536.61 contra «Ventas Canindo 03/10 RD502» $26,536.50.
    const s = casadosPorControl(
      [c('1|23360', 26536.5, '2026-10-07')],
      [c('06-002|U-A-5|0000003|0011', 26536.61, '2026-10-07')],
    );
    expect([...s]).toEqual(['06-002|U-A-5|0000003|0011']);
  });

  it('NEGATIVA: el mismo importe OTRO día no se da por saldado (el Cuadre es por día)', () => {
    // Caso real: Morelia 07 U-A-5 0000009 $11,244.37 (05-oct) que el Control anotó el 07-oct.
    const s = casadosPorControl(
      [c('1|23381', 11244.37, '2026-10-07')],
      [c('07|U-A-5|0000009|0011', 11244.37, '2026-10-05')],
    );
    expect(s.size).toBe(0);
  });

  it('NEGATIVA: un ingreso del Control no salda un gasto de Kepler del mismo importe', () => {
    const s = casadosPorControl(
      [c('1|1', 10105, '2026-10-09', 'in')],
      [c('06|X-D-26|0000161|0011', 10105, '2026-10-09', 'out')],
    );
    expect(s.size).toBe(0);
  });

  it('NEGATIVA: fuera de la tolerancia del Cuadre no casa', () => {
    const s = casadosPorControl(
      [c('1|1', 1000, '2026-10-02')],
      [c('K|1', 1000 + CUADRE_TOLERANCIA_PESOS + 0.01, '2026-10-02')],
    );
    expect(s.size).toBe(0);
  });

  it('un renglón del Control salda UN solo documento aunque haya dos iguales', () => {
    const s = casadosPorControl(
      [c('1|1', 500, '2026-10-02')],
      [c('A|U-A-5|1|0011', 500, '2026-10-02'), c('B|U-A-5|1|0011', 500, '2026-10-02')],
    );
    expect(s.size).toBe(1);
  });
});
