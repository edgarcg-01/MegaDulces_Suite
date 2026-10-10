/**
 * [PU.VG.10] / [PU.VG.11] — La concentración: ¿cuánto de un total está en pocos renglones?
 *
 * Unitaria de verdad: funciones puras, sin Postgres.
 *
 * ⭐ El primer eje es la DEFINICIÓN de «cuántos hacen el 80 %». Medido contra prod el 2026-10-09,
 * el gasto de FY2027 acumula 55.50 + 12.33 + 11.63 = **79.46 %** en tres partidas: tres NO
 * alcanzan el 80 %, hacen falta **cuatro**. Contar «las que caben enteras abajo de la línea»
 * subdeclara en uno, y es justo el renglón que Dirección tendría que tocar. Hay una prueba
 * dedicada al caso que cae EXACTAMENTE en 80.00, donde `>` y `>=` difieren.
 *
 * ⭐ El segundo eje es que una ausencia no es un cero: una fila sin monto legible NO suma 0 al
 * total —eso subdeclararía la concentración justo en el renglón del que no sabemos nada— sino que
 * sale de la base y se declara en `cobertura.sin_monto`.
 *
 * ⛔ El tercer eje es EL UNIVERSO, y entró por una falta real de las dos mitades del módulo:
 * este carril sumó dos ejercicios y publicó 38.72 %; la superficie de ingreso recortó a un canal
 * y lo llamó «del plan» cuando era 81.6 % **de Mostrador** (47.72 % del plan). Las dos cifras son
 * aritméticamente correctas sobre un universo que la frase no nombra. Por eso el universo es un
 * argumento con **unión discriminada**: hay un test que fija que un recorte DEBE declarar de qué
 * es recorte, con los números reales de prod.
 */
import {
  concentracion,
  fraseConcentracion,
  type FilaConcentrable,
  type Universo,
} from './budget-concentration';

const COMPLETO: Universo = { nombre: 'el gasto de 2027', completo: true };

const p = (concept: string, original_amount: unknown, over: Partial<FilaConcentrable> = {}): FilaConcentrable => ({
  concept,
  account_code: '601',
  original_amount,
  control_level: 'advertencia',
  responsible: null,
  expense_class: null,
  ...over,
});

/** El gasto real de FY2027 en prod, medido el 2026-10-09. */
const GASTO_FY2027 = [
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
];

/** Los 8 renglones de Mostrador de FY2027 en prod. Subtotal $353,538,587.63. */
const MOSTRADOR_FY2027 = [
  p('Ventas mostrador · 08', 122891216.83),
  p('Ventas mostrador · 01', 58103857.07),
  p('Ventas mostrador · 06', 54854348.29),
  p('Ventas mostrador · 03', 52778444.77),
  p('Ventas mostrador · 02', 22909527.99),
  p('Ventas mostrador · 07', 22605296.05),
  p('Ventas mostrador · 05', 12838038.62),
  p('Ventas mostrador · 04', 6557858.01),
];

describe('concentracion · el orden y el porcentaje', () => {
  it('ordena descendente por monto y acumula hasta 100 %', () => {
    const r = concentracion([p('CHICA', 10), p('GRANDE', 70), p('MEDIA', 20)], COMPLETO);
    expect(r.filas.map((f) => f.concepto)).toEqual(['GRANDE', 'MEDIA', 'CHICA']);
    expect(r.total).toBe(100);
    expect(r.filas.map((f) => f.pct)).toEqual([70, 20, 10]);
    expect(r.filas.map((f) => f.acumulado)).toEqual([70, 90, 100]);
  });

  it('`pct_mayor` es el porcentaje de la fila más grande: el número que contesta «¿puedo recortar?»', () => {
    expect(concentracion([p('SUELDOS', 55.5), p('RESTO', 44.5)], COMPLETO).pct_mayor).toBe(55.5);
  });

  it('desempata por concepto: dos corridas sobre los mismos datos dan la misma lista', () => {
    const a = concentracion([p('ZETA', 50), p('ALFA', 50)], COMPLETO);
    const b = concentracion([p('ALFA', 50), p('ZETA', 50)], COMPLETO);
    expect(a.filas.map((f) => f.concepto)).toEqual(['ALFA', 'ZETA']);
    expect(b.filas.map((f) => f.concepto)).toEqual(a.filas.map((f) => f.concepto));
  });
});

describe('partidas_80 · la fila que CRUZA la línea, no la última que queda abajo', () => {
  it('reproduce el GASTO FY2027 de prod: tres filas suman 79.46 %, así que la respuesta es CUATRO', () => {
    const r = concentracion(GASTO_FY2027, COMPLETO);
    expect(r.total).toBe(74850066.62);
    expect(r.filas[0].pct).toBe(55.4954);
    expect(r.filas[2].acumulado).toBeCloseTo(79.46, 2);
    expect(r.partidas_80).toBe(4);
  });

  it('⭐ el borde exacto: una fila de 80.00 % YA alcanza, no hacen falta dos', () => {
    const r = concentracion([p('UNA', 80), p('OTRA', 20)], COMPLETO);
    expect(r.filas[0].acumulado).toBe(80);
    expect(r.partidas_80).toBe(1);
  });

  it('una sola fila es el 100 %: la respuesta es una, no cero', () => {
    expect(concentracion([p('UNICA', 1000)], COMPLETO).partidas_80).toBe(1);
  });

  it('el umbral es un corte de DESCRIPCIÓN y viaja en la salida para poder nombrarlo', () => {
    const r = concentracion(GASTO_FY2027, COMPLETO, { umbralPct: 90 });
    expect(r.umbral_pct).toBe(90);
    expect(r.partidas_80).toBe(5); // 88.70 con cuatro no alcanza el 90; la quinta lo cruza (91.52)
    expect(concentracion(GASTO_FY2027, COMPLETO).umbral_pct).toBe(80);
  });
});

describe('⛔ el universo es parte del número', () => {
  it('un universo COMPLETO no obliga a declarar de qué es parte', () => {
    const r = concentracion(GASTO_FY2027, COMPLETO);
    expect(r.universo).toEqual({ nombre: 'el gasto de 2027', completo: true });
  });

  it('reproduce el defecto REAL de la superficie de ingreso: 81.6 % es de Mostrador, no del plan', () => {
    const recorte: Universo = { nombre: 'Mostrador', completo: false, de: 'el plan de ingreso', pct: 58.46 };
    const r = concentracion(MOSTRADOR_FY2027, recorte);
    expect(r.total).toBe(353538587.63);
    // La cifra que la pantalla publicaba, verificada: es correcta DENTRO de Mostrador.
    expect(r.filas[0].pct).toBeCloseTo(34.76, 2);
    expect(r.filas[3].acumulado).toBeCloseTo(81.64, 2);
    // Y lo que la frase callaba: Mostrador es el 58.46 % del plan, así que esas cuatro
    // entidades cargan 81.64 % × 58.46 % = 47.72 % del plan, no el 81.6 %.
    expect(r.universo.completo).toBe(false);
    if (r.universo.completo === false) {
      expect(r.universo.de).toBe('el plan de ingreso');
      expect((r.filas[3].acumulado! * r.universo.pct!) / 100).toBeCloseTo(47.72, 1);
    }
  });

  it('un recorte sin fracción medida la declara NULL, nunca 0', () => {
    const r = concentracion([p('A', 10)], { nombre: 'Mostrador', completo: false, de: 'el plan', pct: null });
    expect(r.universo.completo === false && r.universo.pct).toBeNull();
  });
});

describe('las ausencias se declaran, nunca se suman como cero', () => {
  it('una fila sin monto NO entra al total ni al acumulado, y se cuenta aparte', () => {
    const r = concentracion([p('BUENA', 100), p('MUDA', null)], COMPLETO);
    expect(r.total).toBe(100);
    expect(r.cobertura.sin_monto).toBe(1);
    expect(r.cobertura.partidas).toBe(2);
    const muda = r.filas.find((f) => f.concepto === 'MUDA');
    expect(muda?.monto).toBeNull();
    expect(muda?.pct).toBeNull();
    expect(muda?.acumulado).toBeNull();
  });

  it('la fila sin monto va al FINAL: no se cuela en medio del acumulado', () => {
    const r = concentracion([p('MUDA', ''), p('CHICA', 1), p('GRANDE', 99)], COMPLETO);
    expect(r.filas.map((f) => f.concepto)).toEqual(['GRANDE', 'CHICA', 'MUDA']);
    expect(r.filas[1].acumulado).toBe(100);
  });

  it('un texto no numérico es ausencia, no cero', () => {
    const r = concentracion([p('BUENA', 50), p('RARA', 'N/D')], COMPLETO);
    expect(r.cobertura.sin_monto).toBe(1);
    expect(r.total).toBe(50);
  });

  it('sin filas: total NULL y partidas_80 NULL — no se dibuja un cero', () => {
    const r = concentracion([], COMPLETO);
    expect(r.total).toBeNull();
    expect(r.partidas_80).toBeNull();
    expect(r.pct_mayor).toBeNull();
    expect(r.filas).toEqual([]);
  });

  it('total 0 no permite dividir: se declara, no se publica 0 % ni NaN', () => {
    const r = concentracion([p('A', 0), p('B', 0)], COMPLETO);
    expect(r.total).toBeNull();
    expect(r.partidas_80).toBeNull();
    expect(r.filas.every((f) => f.pct === null)).toBe(true);
  });
});

describe('menores · la frase inversa, dónde NO mirar', () => {
  it('reproduce Mostrador: 2 entidades aportan menos del 5 % cada una', () => {
    const r = concentracion(MOSTRADOR_FY2027, { nombre: 'Mostrador', completo: false, de: 'el plan', pct: 58.46 });
    expect(r.menores.filas).toBe(2); // 05 = 3.63 % y 04 = 1.85 %
    expect(r.menores.monto).toBe(19395896.63);
    expect(r.menores.pct).toBeCloseTo(5.49, 2);
  });

  it('el corte es estricto: una fila de exactamente 5 % NO es «menor»', () => {
    const r = concentracion([p('GRANDE', 95), p('JUSTA', 5)], COMPLETO);
    expect(r.filas[1].pct).toBe(5);
    expect(r.menores.filas).toBe(0);
    expect(r.menores.monto).toBeNull();
  });

  it('una fila SIN monto no se puede llamar chica: no se sabe cuánto es', () => {
    const r = concentracion([p('GRANDE', 100), p('MUDA', null)], COMPLETO);
    expect(r.menores.filas).toBe(0);
    expect(r.cobertura.sin_monto).toBe(1);
  });

  it('el umbral de «menor» también viaja en la salida', () => {
    expect(concentracion([p('A', 10)], COMPLETO).umbral_menor_pct).toBe(5);
    expect(concentracion([p('A', 90), p('B', 10)], COMPLETO, { umbralMenorPct: 15 }).menores.filas).toBe(1);
  });
});

describe('cobertura · lo que falta capturar se cuenta, no se rellena', () => {
  it('reproduce prod: 0 responsables, 0 clases, 0 frenos duros sobre 14 partidas de gasto', () => {
    const r = concentracion(GASTO_FY2027, COMPLETO);
    expect(r.cobertura).toEqual({
      partidas: 14, sin_monto: 0, con_responsable: 0, con_clase: 0, con_freno_duro: 0,
    });
  });

  it('cuenta `bloqueo` y NO `advertencia`: el freno duro es el único que frena', () => {
    const r = concentracion([
      p('CON FRENO', 10, { control_level: 'bloqueo' }),
      p('SIN FRENO', 10, { control_level: 'advertencia' }),
      p('NADA', 10, { control_level: null }),
    ], COMPLETO);
    expect(r.cobertura.con_freno_duro).toBe(1);
  });

  it('un responsable en blanco no cuenta como capturado', () => {
    const r = concentracion([
      p('A', 10, { responsible: '   ' }),
      p('B', 10, { responsible: 'guillermo_lopez' }),
    ], COMPLETO);
    expect(r.cobertura.con_responsable).toBe(1);
  });

  it('⭐ nunca emite veredicto: sin umbral registrado no hay semáforo que publicar', () => {
    expect(concentracion([p('A', 10)], COMPLETO).umbral_registrado).toBe(false);
  });
});

describe('fraseConcentracion · la gramática compartida entre las dos mitades', () => {
  it('CONTESTA, no pregunta, y nombra el universo', () => {
    const f = fraseConcentracion(concentracion(GASTO_FY2027, COMPLETO));
    expect(f.es_ausencia).toBe(false);
    expect(f.titular).toBe('4 de 14 renglones deciden el 80 % del gasto de 2027.');
    expect(f.detalle).toBe('El mayor solo es el 55.50 %.');
  });

  it('⛔ un recorte CARGA su fracción en la frase: es lo que faltaba en «el 81.6 % del plan»', () => {
    const f = fraseConcentracion(concentracion(MOSTRADOR_FY2027,
      { nombre: 'Mostrador', completo: false, de: 'el plan de ingreso', pct: 58.46 }));
    expect(f.titular).toContain('de Mostrador');
    expect(f.detalle).toContain('Mostrador es 58.46 % del plan de ingreso');
  });

  it('un recorte sin fracción medida lo dice, no lo omite', () => {
    const f = fraseConcentracion(concentracion([p('A', 10)],
      { nombre: 'Mostrador', completo: false, de: 'el plan', pct: null }));
    expect(f.detalle).toContain('una parte no medida');
  });

  it('⭐ cuando no se puede decir nada, el TITULAR lo declara (no se deja el bloque vacío)', () => {
    const f = fraseConcentracion(concentracion([], COMPLETO));
    expect(f.es_ausencia).toBe(true);
    expect(f.titular).toBe('Todavía no se puede decir qué parte del gasto de 2027 se puede mover.');
    expect(f.detalle).toBe('No hay renglones cargados.');
    expect(f.inversa).toBeNull();
  });

  it('distingue «no hay renglones» de «hay renglones sin importe»: son dos ausencias distintas', () => {
    const f = fraseConcentracion(concentracion([p('MUDA', null), p('OTRA', '')], COMPLETO));
    expect(f.es_ausencia).toBe(true);
    expect(f.detalle).toBe('Hay 2 renglones y ninguno con un importe que se pueda sumar.');
  });

  it('un solo renglón no dice «1 de 1 deciden»: dice que uno solo decide', () => {
    const f = fraseConcentracion(concentracion([p('UNICA', 500)], COMPLETO));
    expect(f.titular).toBe('Un solo renglón decide el gasto de 2027.');
  });

  it('la inversa dice dónde NO mirar, con su corte nombrado', () => {
    const f = fraseConcentracion(concentracion(MOSTRADOR_FY2027,
      { nombre: 'Mostrador', completo: false, de: 'el plan', pct: 58.46 }));
    expect(f.inversa).toBe('2 renglones aportan menos del 5 % cada uno (5.49 % entre todos): no mueven el total.');
  });

  it('⭐ escribe «del», no «de el»: la frase se publica y un tablero que escribe mal se lee como uno que calcula mal', () => {
    const conEl = fraseConcentracion(concentracion([p('A', 50), p('B', 40), p('C', 10)], { nombre: 'el gasto de 2027', completo: true }));
    expect(conEl.titular).toContain('del gasto de 2027');
    expect(conEl.titular).not.toContain('de el ');
    // Y un universo que NO empieza con artículo no se toca.
    const sinEl = fraseConcentracion(concentracion([p('A', 60), p('B', 40)], { nombre: 'Mostrador', completo: true }));
    expect(sinEl.titular).toContain('de Mostrador');
  });

  it('sin filas chicas no inventa la frase inversa', () => {
    expect(fraseConcentracion(concentracion([p('A', 50), p('B', 50)], COMPLETO)).inversa).toBeNull();
  });
});
