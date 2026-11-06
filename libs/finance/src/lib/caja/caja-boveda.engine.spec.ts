/**
 * `[LE.CU.2]` — Pruebas del replay de la bóveda. Los casos salen de prod (§36.4, 2026-11-04).
 */
import { bovedaEn, signoBoveda, validaReplay, type ConteoBoveda, type MovBoveda } from './caja-boveda.engine';

const mov = (id: number, tipo: string, total: number, at: string): MovBoveda => ({ id, tipo, total, at });
const conteo = (tras_id: number, total: number, at: string): ConteoBoveda => ({ tras_id, total, at });

describe('signoBoveda', () => {
  it('depósito y dotación suman; dispensar y vaciar restan; la foto y el cambio no mueven dinero', () => {
    expect([signoBoveda('Deposito'), signoBoveda('Dotar'), signoBoveda('Dispensar'), signoBoveda('Vaciar Stocks'), signoBoveda('Fin de Dia'), signoBoveda('Cambio')])
      .toEqual([1, 1, -1, -1, 0, 0]);
  });
});

describe('validaReplay', () => {
  const movs = [mov(11, 'Deposito', 500, '2026-11-03T16:00:00Z'), mov(12, 'Dispensar', 300, '2026-11-03T16:10:00Z'), mov(13, 'Cambio', 0, '2026-11-03T16:20:00Z')];

  it('cada inventario = el anterior + el flujo entre los dos', () => {
    const r = validaReplay([conteo(10, 1000, '2026-11-03T15:00:00Z'), conteo(11, 1500, '2026-11-03T16:01:00Z'), conteo(13, 1200, '2026-11-03T16:21:00Z')], movs);
    expect(r).toEqual({ pares: 2, cierran: 2, fallas: [] });
  });

  it('NEGATIVA: un signo cambiado (dispensar como entrada) se cae', () => {
    const r = validaReplay([conteo(11, 1500, '2026-11-03T16:01:00Z'), conteo(12, 1800, '2026-11-03T16:11:00Z')], movs);
    expect(r.cierran).toBe(0);
    expect(r.fallas[0]).toMatchObject({ de: 11, a: 12, diferencia: -600, mismo_evento: false });
  });

  it('la lectura doble del mismo evento (#1820 en prod) se marca como tal, no como hueco del flujo', () => {
    // Como en prod: la segunda lectura tras #1820 sale $2,000 arriba, y la siguiente vuelve a
    // cerrar contra la primera. Fallan dos pares con signos opuestos y neto $0.
    const r = validaReplay([
      conteo(1819, 10000, '2026-10-30T17:30:00Z'), conteo(1820, 8000, '2026-10-30T17:36:00Z'),
      conteo(1820, 10000, '2026-10-30T17:36:30Z'), conteo(1821, 6000, '2026-10-30T17:37:00Z'),
    ], [mov(1820, 'Dispensar', 2000, '2026-10-30T17:35:00Z'), mov(1821, 'Dispensar', 2000, '2026-10-30T17:36:50Z')]);
    expect(r.cierran).toBe(1);
    expect(r.fallas.map((f) => [f.diferencia, f.mismo_evento])).toEqual([[-2000, true], [2000, true]]);
  });
});

describe('bovedaEn', () => {
  const conteos = [conteo(1761, 189530, '2026-10-27T20:28:00Z'), conteo(1774, 388560, '2026-10-27T23:48:00Z')];
  const movs = [
    mov(1700, 'Deposito', 10000, '2026-10-26T18:00:00Z'),
    mov(1750, 'Dispensar', 4000, '2026-10-27T17:00:00Z'),
    mov(1761, 'Deposito', 3530, '2026-10-27T20:27:00Z'),
  ];

  it('con inventario a esa hora, es el inventario', () => {
    expect(bovedaEn('2026-10-28T00:00:00Z', conteos, movs)).toEqual({ monto: 388560, fuente: 'conteo' });
  });

  it('antes del primer inventario, es el replay hacia atrás (así se midió el 10-oct: $342,500)', () => {
    // 189,530 − (+10,000 − 4,000 + 3,530) = 180,000 antes del primer evento.
    expect(bovedaEn('2026-10-26T12:00:00Z', conteos, movs)).toEqual({ monto: 180000, fuente: 'replay' });
    // Entre dos eventos: sólo se deshace lo posterior.
    expect(bovedaEn('2026-10-27T18:00:00Z', conteos, movs)).toEqual({ monto: 186000, fuente: 'replay' });
  });

  it('NEGATIVA: sin ningún inventario se declara sin dato, nunca cero', () => {
    expect(bovedaEn('2026-10-27T18:00:00Z', [], movs)).toEqual({ monto: null, fuente: 'sin_dato' });
  });
});
