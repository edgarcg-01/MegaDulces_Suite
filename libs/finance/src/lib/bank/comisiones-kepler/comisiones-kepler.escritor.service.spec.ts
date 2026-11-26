import { dialDeD3Cierra, escrituraDeComisionesEncendida, ESTADOS_RETOMABLES, fechaDelDial, motivoDeNoReclamar, TIPO_INTERRUPTOR_COMISIONES, type DialDeCuenta } from './comisiones-kepler.escritor.service';

/**
 * `[CB.62.4]` Los diales del escritor. El que importa es **D3**: el cambio de manos va cuenta por cuenta
 * (firmado por Edgar el 2026-11-10, empezando por BBVA 4885) y con FECHA, no con un sí/no.
 */

const diales = (m: Record<string, string | null>): Map<string, DialDeCuenta> =>
  new Map(Object.entries(m).map(([k, v]) => [k, { account_label: k, comisiones_kepler_desde: v }]));

const cargo = (cuenta: string, fecha: string): { cuenta: string; fecha: string } => ({ cuenta, fecha });

describe('[CB.62.4] el dial de D3', () => {
  it('una cuenta SIN fecha la sigue capturando Finanzas: no se escribe', () => {
    const r = dialDeD3Cierra([cargo('4885', '2026-11-20')], diales({ '4885': null }));
    expect(r).toContain('todavía la captura Finanzas');
  });

  it('una cuenta que no está en el padrón tampoco se escribe (falla cerrada)', () => {
    expect(dialDeD3Cierra([cargo('9999', '2026-11-20')], diales({ '4885': '2026-11-26' }))).toContain('9999');
  });

  it('con su fecha puesta y el cargo posterior, pasa', () => {
    expect(dialDeD3Cierra([cargo('4885', '2026-11-26'), cargo('4885', '2026-11-27')], diales({ '4885': '2026-11-26' }))).toBeNull();
  });

  it('⛔ un cargo ANTERIOR al cambio de manos es atraso de Finanzas: no se escribe', () => {
    const r = dialDeD3Cierra([cargo('4885', '2026-11-25'), cargo('4885', '2026-11-27')], diales({ '4885': '2026-11-26' }));
    expect(r).toContain('anteriores al cambio de manos');
    expect(r).toContain('2026-11-26');
  });

  it('⛔ un día con cargos de dos cuentas necesita que las DOS hayan pasado: el gasto es uno y no se parte', () => {
    const d = diales({ '4885': '2026-11-26', '7744': null });
    expect(dialDeD3Cierra([cargo('4885', '2026-11-27'), cargo('7744', '2026-11-27')], d)).toContain('7744');
    expect(dialDeD3Cierra([cargo('4885', '2026-11-27')], d)).toBeNull();
  });

  it('el día mismo del cambio de manos SÍ entra (la fecha es desde, no después de)', () => {
    expect(dialDeD3Cierra([cargo('4885', '2026-11-26')], diales({ '4885': '2026-11-26' }))).toBeNull();
  });
});

describe('[CB.62.4] el freno global', () => {
  it('nace apagado: sin la variable, ni con cualquier otro valor', () => {
    expect(escrituraDeComisionesEncendida({})).toBe(false);
    expect(escrituraDeComisionesEncendida({ KEPLER_COMISIONES_TERMINAL: 'true' })).toBe(false);
    expect(escrituraDeComisionesEncendida({ KEPLER_COMISIONES_TERMINAL: '1' })).toBe(false);
    expect(escrituraDeComisionesEncendida({ KEPLER_COMISIONES_TERMINAL: 'ENCENDIDA' })).toBe(false);
  });

  it('se enciende con la palabra exacta (con espacios alrededor también)', () => {
    expect(escrituraDeComisionesEncendida({ KEPLER_COMISIONES_TERMINAL: 'encendida' })).toBe(true);
    expect(escrituraDeComisionesEncendida({ KEPLER_COMISIONES_TERMINAL: '  encendida  ' })).toBe(true);
  });

  it('el tipo del interruptor por sucursal es el que siembra la migración', () => {
    expect(TIPO_INTERRUPTOR_COMISIONES).toBe('comisiones_terminal');
  });
});

/**
 * ⛔⛔ La FRONTERA base→código, que es donde estuvo el defecto y donde ninguna prueba pura miraba.
 *
 * El 2026-11-26, con los cinco diales abiertos, el canario NO escribió: «2 cargo(s) de la cuenta 4885
 * son anteriores al cambio de manos (Tue Nov 17)». Los cargos eran del 17/11 y D3 era el 17/11. La
 * causa: `pg` entrega un `date` como objeto `Date`, y el código hacía `String(valor).slice(0, 10)`,
 * que da `'Tue Nov 1'`. Como `'2' < 'T'` en ASCII, TODO cargo quedaba como atraso de Finanzas y
 * ninguna cuenta podía escribir nunca.
 */
describe('[CB.62.4] la fecha de D3 tal como la devuelve la base', () => {
  it('un Date de pg se vuelve YYYY-MM-DD, no «Tue Nov 1»', () => {
    // Medianoche LOCAL, que es como pg construye un `date`.
    expect(fechaDelDial(new Date(2026, 10, 17))).toBe('2026-11-17');
  });

  it('un string ya en YYYY-MM-DD no se toca', () => {
    expect(fechaDelDial('2026-11-17')).toBe('2026-11-17');
  });

  it('sin fecha, la cuenta la sigue capturando Finanzas', () => {
    expect(fechaDelDial(null)).toBeNull();
    expect(fechaDelDial(undefined)).toBeNull();
  });

  it('⭐ el caso del canario: un cargo DEL MISMO día del cambio de manos SÍ se escribe', () => {
    const desde = fechaDelDial(new Date(2026, 10, 17));
    expect(dialDeD3Cierra([cargo('4885', '2026-11-17')], diales({ '4885': desde }))).toBeNull();
  });

  it('y el del día ANTERIOR sigue siendo atraso de Finanzas', () => {
    const desde = fechaDelDial(new Date(2026, 10, 17));
    expect(dialDeD3Cierra([cargo('4885', '2026-11-16')], diales({ '4885': desde }))).toContain('atraso de Finanzas');
  });
});

/**
 * `[CB.62.4]` El reclamo del día: qué se puede retomar y qué se DICE cuando no.
 *
 * Tercer defecto del canario del 2026-11-26: el día de la 05 quedó en `rechazado` por el renglón
 * AMPARA, y al reintentar —ya con ese arreglo puesto— la pantalla decía «Otro proceso está
 * escribiendo este día (o ya lo escribió)». No había otro proceso: era su propio renglón de la
 * bitácora, y el día quedaba bloqueado PARA SIEMPRE con un aviso que mandaba a buscar donde no era.
 */
describe('[CB.62.4] el reclamo del día', () => {
  it('un día RECHAZADO se puede retomar: el rechazo no escribió nada', () => {
    expect(ESTADOS_RETOMABLES).toContain('rechazado');
  });

  it('⛔ pero «escrito» y «en_duda» NO se retoman', () => {
    expect(ESTADOS_RETOMABLES).not.toContain('escrito');
    expect(ESTADOS_RETOMABLES).not.toContain('en_duda');
  });

  it('el aviso dice el estado REAL, no una causa inventada', () => {
    expect(motivoDeNoReclamar('escrito')).toMatch(/ya se escribió/);
    expect(motivoDeNoReclamar('escribiendo')).toMatch(/Otro proceso/);
    expect(motivoDeNoReclamar('en_duda')).toMatch(/EN DUDA/);
  });

  it('⭐ «en duda» manda a BUSCARLO en Kepler antes de reintentar, no a reintentar', () => {
    expect(motivoDeNoReclamar('en_duda')).toMatch(/Búscalo en Kepler antes de reintentar/);
  });

  it('un estado que no conocemos se dice tal cual, no se disfraza', () => {
    expect(motivoDeNoReclamar('loquesea')).toContain('loquesea');
  });
});
