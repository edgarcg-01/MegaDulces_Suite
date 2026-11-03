import { claveDeDeposito, rutaDeDeposito } from './caos-ruta-caja.service';
import { atribuirDeposito, esVecinal } from './caos-deposito-grano';

/**
 * `[CG.58.7]` El candado de la PRECEDENCIA de atribución.
 *
 * Por qué merece candado propio: la clave que devuelve esta función viaja en cada depósito hasta
 * la pantalla y es con lo que el panel decide qué detalle abrir bajo qué fila. Si la precedencia
 * cambia, la tabla sigue pintando — con los depósitos de otra ruta. No hay error, no hay rojo:
 * sólo un número que le cobra el dinero a quien no fue.
 */
describe('claveDeDeposito — una sola precedencia, y la vecinal manda', () => {
  it('vecinal gana aunque el texto también declare ruta y plaza', () => {
    expect(claveDeDeposito({ vecinal: true, ruta: '28', plaza: 'canindo' })).toBe('vecinal');
  });

  it('la ruta gana sobre la plaza', () => {
    expect(claveDeDeposito({ vecinal: false, ruta: '28', plaza: 'canindo' })).toBe('ruta:28');
  });

  it('la plaza es el último grano antes de rendirse', () => {
    expect(claveDeDeposito({ vecinal: false, ruta: null, plaza: 'canindo' })).toBe('plaza:canindo');
  });

  it('sin nada declarado NO inventa una ruta', () => {
    expect(claveDeDeposito({ vecinal: false, ruta: null, plaza: null })).toBe('sin_declarar');
  });

  /**
   * ⭐ El candado que importa: la clave tiene que salir de lo que el clasificador REALMENTE
   * devuelve para textos de prod, no de valores inventados a mano para este test. Los `ref` son
   * los de `analytics.caos_cash_movements`, con sus erratas.
   */
  it.each([
    ['rd 28 13 10 26', 'ruta:28'],
    ['ruta22131026', 'ruta:22'],
    ['rd28', 'ruta:28'],
    ['ruta 28 ph', 'ruta:28'],
    ['rd can 26/05', 'plaza:canindo'],
    ['rd mor 26/05', 'plaza:morelia'],
    ['RV MORELIA RV15-321-15-321', 'vecinal'],
    ['ruta vecinal 07/10', 'vecinal'],
    ['cj 15 26/05', 'sin_declarar'],
    ['', 'sin_declarar'],
  ])('sobre el texto real %s → %s', (ref, esperada) => {
    const a = atribuirDeposito(ref, '2026-10-13');
    expect(claveDeDeposito({ vecinal: esVecinal(ref), ruta: a.ruta, plaza: a.plaza })).toBe(esperada);
  });

  /**
   * Prueba negativa de la invariante que sostiene el agrupado: dos depósitos de la MISMA ruta
   * caen en la misma clave aunque uno declare el día y el otro no. Si no fuera así, la ruta 28
   * saldría partida en dos filas y ninguna de las dos cerraría contra su venta.
   */
  it('⭐ el mismo camión cae en UNA fila, declare o no el día', () => {
    const conDia = atribuirDeposito('rd 28 13 10 26', '2026-10-13');
    const sinDia = atribuirDeposito('rd28', '2026-10-13');
    expect(conDia.grano).toBe('ruta_dia');
    expect(sinDia.grano).toBe('ruta');
    expect(claveDeDeposito({ vecinal: false, ruta: conDia.ruta, plaza: conDia.plaza }))
      .toBe(claveDeDeposito({ vecinal: false, ruta: sinDia.ruta, plaza: sinDia.plaza }));
  });

  /** Y la contraria: dos rutas distintas NUNCA comparten clave. */
  it('rutas distintas no se funden', () => {
    const claves = ['rd 21 13 10 26', 'rd 22 13 10 26', 'rd 28 13 10 26'].map((ref) => {
      const a = atribuirDeposito(ref, '2026-10-13');
      return claveDeDeposito({ vecinal: esVecinal(ref), ruta: a.ruta, plaza: a.plaza });
    });
    expect(new Set(claves).size).toBe(3);
  });
});

/**
 * `[CG.58.8]` La ruta que pone la LIGA de Caja General. Casos de prod (2026-11-03): `rd canindo
 * 12/10` (#1642) se liga a cobros de 502/503/504; `ruta22221026` (#1704) se ligó al cobro de la
 * 26 — el texto y la liga se contradicen.
 */
describe('rutaDeDeposito — el texto manda, la liga completa', () => {
  it('el texto manda aunque haya liga, y si coincide no hay contradicción', () => {
    expect(rutaDeDeposito('22', ['22'])).toEqual({ ruta: '22', ruta_por: 'texto', ruta_contradice: false });
  });

  it('⭐ texto y liga dicen rutas distintas: gana el texto y se PUBLICA', () => {
    expect(rutaDeDeposito('22', ['26'])).toEqual({ ruta: '22', ruta_por: 'texto', ruta_contradice: true });
  });

  it('sin ruta en el texto y la liga es de UNA ruta: la ruta sale de la liga', () => {
    const r = rutaDeDeposito(null, ['502']);
    expect(r).toEqual({ ruta: '502', ruta_por: 'liga', ruta_contradice: false });
    expect(claveDeDeposito({ vecinal: false, ruta: r.ruta, plaza: 'canindo' })).toBe('ruta:502');
  });

  it('⛔ liga de VARIAS rutas no elige una: el depósito se queda en su plaza', () => {
    const r = rutaDeDeposito(null, ['502', '503', '504']);
    expect(r.ruta).toBeNull();
    expect(claveDeDeposito({ vecinal: false, ruta: r.ruta, plaza: 'canindo' })).toBe('plaza:canindo');
  });

  it('sin texto ni liga no inventa nada', () => {
    expect(rutaDeDeposito(null, [])).toEqual({ ruta: null, ruta_por: null, ruta_contradice: false });
  });
});
