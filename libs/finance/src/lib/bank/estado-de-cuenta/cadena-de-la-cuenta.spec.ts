import { ArchivoEnCadena, SaldoConocido, probarCuentasPorCadena } from './cadena-de-la-cuenta';

/** `[BFU.1.3]` Con la forma de los casos de prod del 2026-11-19 (importes inventados). */
const arch = (id: string, cuenta: string, check: ArchivoEnCadena['check'], desde: string, apertura: number): ArchivoEnCadena =>
  ({ id, cuenta, check, desde, apertura });
const linea = (archivo: string | null, cuenta: string, fecha: string, saldo: number): SaldoConocido => ({ archivo, cuenta, fecha, saldo });

describe('[BFU.1.3] probarCuentasPorCadena', () => {
  it('un archivo sin testigo que abre en el saldo de una línea de un archivo comprobado queda probado', () => {
    const p = probarCuentasPorCadena(
      [arch('a', '4885', 'saldo_continuo', '2026-11-03', 100), arch('b', '4885', 'sin_testigo', '2026-11-05', 250)],
      [linea('a', '4885', '2026-11-04', 250)],
    );
    expect(p.get('a')).toBe('saldo_continuo');
    expect(p.get('b')).toBe('cadena');
  });

  it('se encadena: el segundo se prueba con el primero recién probado, en cualquier orden', () => {
    const p = probarCuentasPorCadena(
      [arch('c', '4176', 'sin_testigo', '2026-11-08', 300), arch('b', '4176', 'sin_testigo', '2026-11-05', 200), arch('a', '4176', 'en_archivo', '2026-11-01', 100)],
      [linea('a', '4176', '2026-11-04', 200), linea('b', '4176', '2026-11-07', 300)],
    );
    expect(p.get('b')).toBe('cadena');
    expect(p.get('c')).toBe('cadena');
  });

  it('el libro es ancla: un renglón del libro ANTES del primer día con ese saldo', () => {
    const p = probarCuentasPorCadena([arch('a', '5712', 'sin_testigo', '2026-11-03', 8433.92)], [linea(null, '5712', '2026-10-31', 8433.92)]);
    expect(p.get('a')).toBe('cadena');
  });

  it('control: un saldo igual en OTRA cuenta no prueba nada', () => {
    const p = probarCuentasPorCadena(
      [arch('a', '4885', 'saldo_continuo', '2026-11-03', 100), arch('b', '4176', 'sin_testigo', '2026-11-05', 250)],
      [linea('a', '4885', '2026-11-04', 250)],
    );
    expect(p.get('b')).toBeNull();
  });

  it('control: una cadena de archivos sin testigo entre sí, sin ancla, no se prueba sola', () => {
    const p = probarCuentasPorCadena(
      [arch('a', '3660', 'sin_testigo', '2026-11-03', 100), arch('b', '3660', 'sin_testigo', '2026-11-12', 200)],
      [linea('a', '3660', '2026-11-06', 200), linea('b', '3660', '2026-11-13', 300)],
    );
    expect(p.get('a')).toBeNull();
    expect(p.get('b')).toBeNull();
  });

  it('control: fuera de la ventana de días o del mismo archivo no cuenta', () => {
    expect(probarCuentasPorCadena(
      [arch('a', '1', 'en_archivo', '2026-10-01', 1), arch('b', '1', 'sin_testigo', '2026-11-20', 50)],
      [linea('a', '1', '2026-11-10', 50)],
    ).get('b')).toBeNull();
    expect(probarCuentasPorCadena([arch('b', '1', 'sin_testigo', '2026-11-05', 50)], [linea('b', '1', '2026-11-05', 50)]).get('b')).toBeNull();
    // el libro del MISMO primer día no prueba la apertura: puede ser un saldo de después
    expect(probarCuentasPorCadena([arch('b', '1', 'sin_testigo', '2026-11-05', 50)], [linea(null, '1', '2026-11-05', 50)]).get('b')).toBeNull();
  });

  it('los centavos cuentan: $250.01 no es $250.00', () => {
    const p = probarCuentasPorCadena(
      [arch('a', '1', 'en_archivo', '2026-11-01', 1), arch('b', '1', 'sin_testigo', '2026-11-05', 250.01)],
      [linea('a', '1', '2026-11-04', 250)],
    );
    expect(p.get('b')).toBeNull();
  });
});
