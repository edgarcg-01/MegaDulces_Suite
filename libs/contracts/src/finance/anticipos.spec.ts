/**
 * `[PGP.118]` Las reglas del submódulo de Anticipos.
 *
 * Vectores SINTÉTICOS (el repo es público): reproducen la forma de los casos medidos en prod sin
 * nombres ni montos reales.
 */
import { disponibleDeAnticipo, grupoDeAnticipo, llaveAnticipo, neteableHoy, tipoDeAcreedor, tramoDeAnticipo } from './anticipos.contract';

describe('[PGP.118] tipoDeAcreedor', () => {
  it('C* es mercancía, G* gasto, TC* tarjeta', () => {
    expect(tipoDeAcreedor('CF001')).toBe('mercancia');
    expect(tipoDeAcreedor('GL002')).toBe('gasto');
    expect(tipoDeAcreedor('TC003')).toBe('tarjeta');
  });
  it('⛔ TC no se confunde con otra cosa por empezar con T', () => {
    expect(tipoDeAcreedor('TI004')).toBe('otro');
  });
  it('tolera espacios y minúsculas de Kepler', () => {
    expect(tipoDeAcreedor('  cf001 ')).toBe('mercancia');
  });
  it('sin código no se inventa un tipo', () => {
    expect(tipoDeAcreedor(null)).toBe('otro');
    expect(tipoDeAcreedor('')).toBe('otro');
  });
});

describe('[PGP.118] grupoDeAnticipo', () => {
  it('mercancía con deuda viva: aplicable hoy', () => {
    expect(grupoDeAnticipo('CF001', 1000)).toBe('aplicable');
  });
  it('mercancía sin deuda: sin contra qué (pedir factura o reembolso)', () => {
    expect(grupoDeAnticipo('CF001', 0)).toBe('sin_contra_que');
    expect(grupoDeAnticipo('CF001', 0.004)).toBe('sin_contra_que');
  });
  it('⛔ la deuda que todavía no llegó es «calculando», NUNCA «sin contra qué»', () => {
    expect(grupoDeAnticipo('CF001', null)).toBe('calculando');
    expect(grupoDeAnticipo('CF001', undefined)).toBe('calculando');
    expect(grupoDeAnticipo('CF001', Number.NaN)).toBe('calculando');
  });
  it('⛔ gasto y tarjeta nunca son «aplicables», aunque se les deba', () => {
    expect(grupoDeAnticipo('GL002', 5000)).toBe('no_mercancia');
    expect(grupoDeAnticipo('TC003', 5000)).toBe('no_mercancia');
    expect(grupoDeAnticipo('XX009', 5000)).toBe('no_mercancia');
  });
});

describe('[PGP.118] tramoDeAnticipo', () => {
  it('los cortes son inclusivos: 30 y 90 quedan en su tramo', () => {
    expect(tramoDeAnticipo(0)).toBe('0-30');
    expect(tramoDeAnticipo(30)).toBe('0-30');
    expect(tramoDeAnticipo(31)).toBe('31-90');
    expect(tramoDeAnticipo(90)).toBe('31-90');
    expect(tramoDeAnticipo(91)).toBe('+90');
  });
  it('sin fecha se declara, no se cuenta como reciente', () => {
    expect(tramoDeAnticipo(null)).toBe('sin_fecha');
    expect(tramoDeAnticipo(Number.NaN)).toBe('sin_fecha');
  });
});

describe('[PGP.118] neteableHoy', () => {
  it('nunca más que el anticipo ni más que la deuda', () => {
    expect(neteableHoy(1000, 400)).toBe(400);
    expect(neteableHoy(400, 1000)).toBe(400);
  });
  it('sin deuda: cero, que es distinto de «no sé»', () => {
    expect(neteableHoy(1000, 0)).toBe(0);
  });
  it('⛔ la deuda que no llegó da null, no cero', () => {
    expect(neteableHoy(1000, null)).toBeNull();
    expect(neteableHoy(1000, undefined)).toBeNull();
  });
});

describe('[PGP.120] llaveAnticipo y disponibleDeAnticipo', () => {
  it('la llave junta acreedor y sucursal, sin espacios ni mayúsculas de por medio', () => {
    expect(llaveAnticipo(' cf001 ', '00')).toBe('CF001|00');
    expect(llaveAnticipo('CF001', '03')).not.toBe(llaveAnticipo('CF001', '00'));
  });
  it('lo disponible es lo de Kepler menos lo apartado en el Calendario, nunca negativo', () => {
    expect(disponibleDeAnticipo({ a_favor: 1000, apartado: 400 })).toBe(600);
    expect(disponibleDeAnticipo({ a_favor: 1000, apartado: 1200 })).toBe(0);
    expect(disponibleDeAnticipo({ a_favor: 1000, apartado: 0 })).toBe(1000);
  });
});
