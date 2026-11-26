import { dialDeD3Cierra, escrituraDeComisionesEncendida, TIPO_INTERRUPTOR_COMISIONES, type DialDeCuenta } from './comisiones-kepler.escritor.service';

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
