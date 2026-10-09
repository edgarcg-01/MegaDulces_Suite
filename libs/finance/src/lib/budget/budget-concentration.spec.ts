/**
 * [PU.VG.10] — La concentración: ¿cuánto del gasto de un ejercicio puede mover Dirección?
 *
 * Unitaria de verdad: función pura, sin Postgres.
 *
 * ⭐ El eje que importa es la DEFINICIÓN de «cuántas partidas hacen el 80 %». Medido contra prod
 * el 2026-10-09, FY2027 acumula 55.50 + 12.33 + 11.63 = **79.46 %** en tres partidas: tres NO
 * alcanzan el 80 %, hacen falta **cuatro**. Contar «las que caben enteras abajo de la línea»
 * subdeclara en uno, y es justo el renglón que Dirección tendría que tocar. Hay una prueba
 * dedicada al caso que cae EXACTAMENTE en 80.00, donde `>` y `>=` difieren.
 *
 * ⭐ El segundo eje es que una ausencia no es un cero: una partida sin monto legible NO suma 0 al
 * total —eso subdeclararía la concentración justo en el renglón del que no sabemos nada— sino que
 * sale de la base y se declara en `cobertura.sin_monto`.
 */
import { concentracionDeGasto, type PartidaRow } from './budget-concentration';

const p = (concept: string, original_amount: unknown, over: Partial<PartidaRow> = {}): PartidaRow => ({
  concept,
  account_code: '601',
  original_amount,
  control_level: 'advertencia',
  responsible: null,
  expense_class: null,
  ...over,
});

describe('concentracionDeGasto · el orden y el porcentaje', () => {
  it('ordena descendente por monto y acumula hasta 100 %', () => {
    const r = concentracionDeGasto([p('CHICA', 10), p('GRANDE', 70), p('MEDIA', 20)]);
    expect(r.filas.map((f) => f.concepto)).toEqual(['GRANDE', 'MEDIA', 'CHICA']);
    expect(r.total).toBe(100);
    expect(r.filas.map((f) => f.pct)).toEqual([70, 20, 10]);
    expect(r.filas.map((f) => f.acumulado)).toEqual([70, 90, 100]);
  });

  it('`pct_mayor` es el porcentaje de la partida más grande: el número que contesta «¿puedo recortar?»', () => {
    const r = concentracionDeGasto([p('SUELDOS', 55.5), p('RESTO', 44.5)]);
    expect(r.pct_mayor).toBe(55.5);
  });

  it('desempata por concepto: dos corridas sobre los mismos datos dan la misma lista', () => {
    const a = concentracionDeGasto([p('ZETA', 50), p('ALFA', 50)]);
    const b = concentracionDeGasto([p('ALFA', 50), p('ZETA', 50)]);
    expect(a.filas.map((f) => f.concepto)).toEqual(['ALFA', 'ZETA']);
    expect(b.filas.map((f) => f.concepto)).toEqual(a.filas.map((f) => f.concepto));
  });
});

describe('partidas_80 · la partida que CRUZA la línea, no la última que queda abajo', () => {
  it('reproduce FY2027 de prod: tres partidas suman 79.46 %, así que la respuesta es CUATRO', () => {
    const r = concentracionDeGasto([
      p('SUELDOS Y SALARIOS', 41538367.09),
      p('GASTOS LOGISTICOS', 9230750.68),
      p('GASTOS DE VENTA', 8705596.8),
      p('GASTOS DE LOCAL', 6914410.12),
      p('GASTOS DE DIRECICON', 2113142.89),
      p('GASTOS PUBLICIDAD Y PROMOCION', 1981509.61),
      p('GASTOS ADMINISTRATIVOS', 1768061.73),
      p('GASTO EN TECNOLOGIA', 1147589.24),
      p('GASTOS EN TECNOLOGIA', 533603.88),
      p('GASTOS CONTABLES', 434530.95),
      p('GASTO DE PAPELERIA', 231621.14),
      p('GASTOS EN MOBILIARIO Y EQUIPO', 153638.86),
      p('OTROS GASTOS', 54144.38),
      p('OTROS GASTOS NO DEDUCIBLES', 43099.25),
    ]);
    expect(r.total).toBe(74850066.62);
    expect(r.filas[0].pct).toBe(55.4954);
    expect(r.filas[2].acumulado).toBeCloseTo(79.46, 2);
    expect(r.partidas_80).toBe(4);
  });

  it('reproduce FY2026 de prod: tres partidas (87.31 %)', () => {
    const r = concentracionDeGasto([
      p('SUELDOS Y SALARIOS', 16285102.8),
      p('GASTOS LOGISTICOS', 6233983.33),
      p('GASTOS DE LOCAL', 5793407.76),
      p('GASTOS DE VENTA', 1685755.16),
      p('GASTOS PUBLICIDAD Y PROMOCION', 888024.74),
      p('GASTOS ADMINISTRATIVOS', 501939.83),
      p('GASTO DE PAPELERIA', 388813.51),
      p('GASTO EN TECNOLOGIA', 207854.32),
      p('GASTOS EN MOBILIARIO Y EQUIPO', 205870.45),
      p('GASTOS CONTABLES', 112985.03),
      p('OTROS GASTOS', 64682.27),
      p('GASTOS DE DIRECICON', 57423.86),
    ]);
    expect(r.total).toBe(32425843.06);
    expect(r.partidas_80).toBe(3);
  });

  it('⭐ el borde exacto: una partida de 80.00 % YA alcanza, no hacen falta dos', () => {
    const r = concentracionDeGasto([p('UNA', 80), p('OTRA', 20)]);
    expect(r.filas[0].acumulado).toBe(80);
    expect(r.partidas_80).toBe(1);
  });

  it('una sola partida es el 100 %: la respuesta es una, no cero', () => {
    expect(concentracionDeGasto([p('UNICA', 1000)]).partidas_80).toBe(1);
  });
});

describe('las ausencias se declaran, nunca se suman como cero', () => {
  it('una partida sin monto NO entra al total ni al acumulado, y se cuenta aparte', () => {
    const r = concentracionDeGasto([p('BUENA', 100), p('MUDA', null)]);
    expect(r.total).toBe(100);
    expect(r.cobertura.sin_monto).toBe(1);
    expect(r.cobertura.partidas).toBe(2);
    const muda = r.filas.find((f) => f.concepto === 'MUDA');
    expect(muda?.monto).toBeNull();
    expect(muda?.pct).toBeNull();
    expect(muda?.acumulado).toBeNull();
  });

  it('la fila sin monto va al FINAL: no se cuela en medio del acumulado', () => {
    const r = concentracionDeGasto([p('MUDA', ''), p('CHICA', 1), p('GRANDE', 99)]);
    expect(r.filas.map((f) => f.concepto)).toEqual(['GRANDE', 'CHICA', 'MUDA']);
    expect(r.filas[1].acumulado).toBe(100);
  });

  it('un texto no numérico es ausencia, no cero', () => {
    const r = concentracionDeGasto([p('BUENA', 50), p('RARA', 'N/D')]);
    expect(r.cobertura.sin_monto).toBe(1);
    expect(r.total).toBe(50);
  });

  it('sin partidas: total NULL y partidas_80 NULL — no se dibuja un cero', () => {
    const r = concentracionDeGasto([]);
    expect(r.total).toBeNull();
    expect(r.partidas_80).toBeNull();
    expect(r.pct_mayor).toBeNull();
    expect(r.filas).toEqual([]);
  });

  it('total 0 no permite dividir: se declara, no se publica 0 % ni NaN', () => {
    const r = concentracionDeGasto([p('A', 0), p('B', 0)]);
    expect(r.total).toBeNull();
    expect(r.partidas_80).toBeNull();
    expect(r.filas.every((f) => f.pct === null)).toBe(true);
  });
});

describe('cobertura · lo que falta capturar se cuenta, no se rellena', () => {
  it('reproduce prod: 0 responsables, 0 clases, 0 frenos duros sobre 26 partidas', () => {
    const filas = Array.from({ length: 26 }, (_, i) => p(`P${i}`, 1000));
    const r = concentracionDeGasto(filas);
    expect(r.cobertura).toEqual({
      partidas: 26, sin_monto: 0, con_responsable: 0, con_clase: 0, con_freno_duro: 0,
    });
  });

  it('cuenta `bloqueo` y NO `advertencia`: el freno duro es el único que frena', () => {
    const r = concentracionDeGasto([
      p('CON FRENO', 10, { control_level: 'bloqueo' }),
      p('SIN FRENO', 10, { control_level: 'advertencia' }),
      p('NADA', 10, { control_level: null }),
    ]);
    expect(r.cobertura.con_freno_duro).toBe(1);
  });

  it('un responsable en blanco no cuenta como capturado', () => {
    const r = concentracionDeGasto([
      p('A', 10, { responsible: '   ' }),
      p('B', 10, { responsible: 'guillermo_lopez' }),
    ]);
    expect(r.cobertura.con_responsable).toBe(1);
  });

  it('⭐ nunca emite veredicto: sin umbral registrado no hay semáforo que publicar', () => {
    expect(concentracionDeGasto([p('A', 10)]).umbral_registrado).toBe(false);
  });
});
