import { motivoSinResultado, resultadoEjercicio, tipoLabel, type FilaPorTipo } from './presupuesto-resultado';

/**
 * `[PVI.16]` — **El ejercicio tiene dos lados, y todavía no puede decir un resultado.**
 *
 * La primera prueba es el estado REAL de producción, medido el 2026-10-09 sobre `PRE-2027-002`:
 * `ingreso` 33 partidas / $604,775,116 y `gasto` 14 / $74,850,067, **sin una sola partida de
 * `costo_ventas`**. Con eso, la resta que la pantalla invitaba a hacer daría **87.6 % de margen**
 * sobre un ejercicio que no presupuestó lo que vende.
 *
 * ⭐ Y la regla es ESTRUCTURAL, no una heurística sobre nombres: el `CHECK` de la tabla admite
 * seis tipos y `costo_ventas` es uno de ellos. El casillero existe y está vacío — por eso se puede
 * nombrar lo que falta en vez de decir «no se puede calcular».
 */

const fila = (line_type: string, vigente: number | string): FilaPorTipo => ({ line_type, vigente });

/** El roll-up que `variance` devuelve hoy para el ejercicio real. */
const PROD: FilaPorTipo[] = [fila('ingreso', 604_775_116), fila('gasto', 74_850_067)];

describe('[PVI.16] el estado real: dos lados y ningún resultado', () => {
  it('⛔ EL CASO DE PROD: no publica resultado, y dice que falta el costo de ventas', () => {
    const r = resultadoEjercicio(PROD);
    expect(r.ingreso).toBe(604_775_116);
    expect(r.egreso_operativo).toBe(74_850_067);
    expect(r.resultado).toBeNull();
    expect(r.faltan).toEqual(['costo_ventas']);
  });

  it('⭐ el motivo dice QUÉ falta y QUÉ pasaría si se restara igual', () => {
    const m = motivoSinResultado(resultadoEjercicio(PROD));
    expect(m).toContain('Costo de ventas');
    expect(m).toContain('87.6 %');   // (604,775,116 - 74,850,067) / 604,775,116
  });

  it('⛔ PRUEBA NEGATIVA: la resta ingenua da justo ese 87.6 % — por eso no se publica', () => {
    const ingenuo = (604_775_116 - 74_850_067) / 604_775_116;
    expect(Math.round(ingenuo * 1000) / 10).toBe(87.6);
    expect(resultadoEjercicio(PROD).resultado).toBeNull();
  });

  it('los SEIS lados se declaran, también los ausentes', () => {
    const r = resultadoEjercicio(PROD);
    expect(r.lados.map((l) => l.tipo)).toEqual(['ingreso', 'costo_ventas', 'gasto', 'compra_inventario', 'inversion', 'flujo']);
    expect(r.lados.filter((l) => l.presente).map((l) => l.tipo)).toEqual(['ingreso', 'gasto']);
    expect(r.lados.find((l) => l.tipo === 'costo_ventas')).toEqual({ tipo: 'costo_ventas', presente: false, vigente: 0 });
  });
});

describe('[PVI.16] «vale cero» no es «no existe»', () => {
  it('⛔ un costo de ventas presupuestado EN CERO sí permite restar', () => {
    const r = resultadoEjercicio([...PROD, fila('costo_ventas', 0)]);
    expect(r.lados.find((l) => l.tipo === 'costo_ventas')).toEqual({ tipo: 'costo_ventas', presente: true, vigente: 0 });
    expect(r.faltan).toEqual([]);
    expect(r.resultado).toBe(604_775_116 - 74_850_067);
    expect(motivoSinResultado(r)).toBeNull();
  });

  it('con los tres lados, el resultado es la resta completa', () => {
    const r = resultadoEjercicio([fila('ingreso', 1000), fila('costo_ventas', 600), fila('gasto', 250)]);
    expect(r.resultado).toBe(150);
    expect(r.faltan).toEqual([]);
  });

  it('sin ingreso tampoco se inventa: falta más de un lado y se nombran todos', () => {
    const r = resultadoEjercicio([fila('gasto', 100)]);
    expect(r.faltan).toEqual(['ingreso', 'costo_ventas']);
    expect(motivoSinResultado(r)).toContain('Ingreso y Costo de ventas');
  });

  it('sin ingreso no se calcula un margen falso para el aviso', () => {
    const m = motivoSinResultado(resultadoEjercicio([fila('gasto', 100)]));
    expect(m).not.toContain('%');
  });
});

describe('[PVI.16] la forma en que llegan los datos', () => {
  it('los montos vienen como CADENA del driver y se suman igual', () => {
    const r = resultadoEjercicio([fila('ingreso', '604775116.00'), fila('gasto', '74850067.00')]);
    expect(r.ingreso).toBe(604_775_116);
    expect(r.egreso_operativo).toBe(74_850_067);
  });

  it('dos filas del mismo tipo se acumulan, no se pisan', () => {
    const r = resultadoEjercicio([fila('gasto', 10), fila('gasto', 5), fila('ingreso', 100), fila('costo_ventas', 1)]);
    expect(r.egreso_operativo).toBe(15);
    expect(r.resultado).toBe(100 - 1 - 15);
  });

  it('un tipo fuera del vocabulario no rompe ni se cuela', () => {
    const r = resultadoEjercicio([...PROD, fila('inventado', 999)]);
    expect(r.lados.some((l) => (l.tipo as string) === 'inventado')).toBe(false);
    expect(r.ingreso).toBe(604_775_116);
  });

  it('sin filas no afirma nada', () => {
    const r = resultadoEjercicio(null);
    expect(r.resultado).toBeNull();
    expect(r.ingreso).toBe(0);
    expect(r.lados.every((l) => !l.presente)).toBe(true);
    expect(r.faltan).toEqual(['ingreso', 'costo_ventas', 'gasto']);
  });

  it('los rótulos son legibles', () => {
    expect(tipoLabel('costo_ventas')).toBe('Costo de ventas');
    expect(tipoLabel('gasto')).toBe('Gasto operativo');
  });
});
