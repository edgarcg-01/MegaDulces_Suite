/**
 * CG.20 — Pruebas del lote y de los frecuentes (ADR-070).
 *
 * Las dos que definen la fase son negativas:
 *   · una ruta sin cuenta declarada **NO** se puede confirmar en lote — cae a captura manual, y
 *     nunca a una cuenta adivinada;
 *   · una fila que falla **NO** tumba a las demás — si el lote fuera todo-o-nada, la persona
 *     volvería a capturar de a una y toda la fase sería inútil.
 */
import {
  esConfirmable, cuentaPorRegla, aplicaPatron, resumirLote, evaluarDescuadre, rankearFrecuentes,
  esFechaFutura, cvDe, propuestaDe, CAIDO_DIAS, TEXTO_NO_CONFIRMABLE, FRECUENTE_MIN_USOS, LOTE_EPSILON, REGLA_MAX_PATRON,
  type MapaRuta, type FilaLote, type UsoGasto, type ReglaGasto,
} from './caja-lote.engine';

const ok: MapaRuta = {
  cliente_code: 'RD 21', confirmed_at: '2026-09-01T00:00:00Z',
  kepler_cuenta: '41000001', kepler_concepto: '001',
};
const ent = (monto = 1000, ref = '00|0027628') => ({ origen_ref: ref, cliente_code: 'RD 21', monto });

describe('esConfirmable — nada se elige a mano, o no se confirma', () => {
  it('con la ruta declarada y firmada, devuelve la cuenta lista', () => {
    const r = esConfirmable(ent(), ok);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.kepler_cuenta).toBe('41000001'); expect(r.kepler_concepto).toBe('001'); }
  });

  it('⛔ [negativa] SIN CUENTA declarada no se confirma — y NO se inventa una', () => {
    const r = esConfirmable(ent(), { ...ok, kepler_cuenta: null, kepler_concepto: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('sin_cuenta');
  });

  it('⛔ [negativa] una propuesta SIN FIRMAR no alcanza para aplicar dinero', () => {
    const r = esConfirmable(ent(), { ...ok, confirmed_at: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('sin_confirmar');
  });

  it('una ruta que ni existe en el mapa se distingue de una sin firmar', () => {
    const a = esConfirmable(ent(), null);
    const b = esConfirmable(ent(), { ...ok, confirmed_at: null });
    expect(a.ok).toBe(false); expect(b.ok).toBe(false);
    // Los dos son "no", pero uno lo arregla el capturista y el otro no. No pueden ser el mismo.
    if (!a.ok && !b.ok) expect(a.motivo).not.toBe(b.motivo);
  });

  it('un cobro sin importe no es confirmable (y lo dice)', () => {
    const r = esConfirmable(ent(0), ok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('sin_monto');
  });

  it('cada motivo tiene un texto propio: un motivo sin frase no le sirve a nadie', () => {
    const motivos = ['sin_mapa', 'sin_confirmar', 'sin_cuenta', 'sin_monto'] as const;
    motivos.forEach((m) => expect(TEXTO_NO_CONFIRMABLE[m].length).toBeGreaterThan(20));
  });
});

describe('cuentaPorRegla — CG.21, el egreso resuelve su cuenta o no se confirma', () => {
  // `id` distinto por regla, como en la base: `finance.caja_classify_rules.id` es un uuid PK, así
  // que dos reglas NUNCA lo comparten. Un fixture que sí lo compartiera probaría un caso imposible.
  const r = (p: number, ben: string | null, cuenta: string, concepto = '001', tipo: string | null = 'gasto'): ReglaGasto =>
    ({ id: `r${p}-${cuenta}`, priority: p, match_tipo: tipo, match_glosa: null, match_beneficiario: ben, kepler_cuenta: cuenta, kepler_concepto: concepto });
  const mov = (ben: string, monto = 1000) => ({ tipo: 'gasto', glosa: null, beneficiario: ben, monto });

  it('la regla declarada resuelve la cuenta sin que nadie elija', () => {
    const v = cuentaPorRegla(mov('CB013'), [r(10, '^CB013$', '1005')]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.kepler_cuenta).toBe('1005');
  });

  it('⛔ [negativa] SIN regla que aplique NO se confirma — y NO se inventa una cuenta', () => {
    const v = cuentaPorRegla(mov('GX999'), [r(10, '^CB013$', '1005')]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toBe('sin_regla');
  });

  it('⛔ [negativa] una lista de reglas VACÍA no propone nada (no hay default)', () => {
    expect(cuentaPorRegla(mov('CB013'), []).ok).toBe(false);
    expect(cuentaPorRegla(mov('CB013'), null).ok).toBe(false);
  });

  it('⛔ [negativa] una regla SIN NINGÚN matcher aplicaría a todo: se descarta', () => {
    const suelta: ReglaGasto = { id: 'x', priority: 1, match_tipo: null, match_glosa: null,
      match_beneficiario: null, kepler_cuenta: '9999', kepler_concepto: '001' };
    const v = cuentaPorRegla(mov('LO QUE SEA'), [suelta]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toBe('sin_regla');
  });

  it('⭐ la PRIMERA por prioridad gana, aunque la otra también aplique', () => {
    const v = cuentaPorRegla(mov('CB013'), [r(50, 'CB', '9999'), r(10, '^CB013$', '1005')]);
    if (v.ok) expect(v.kepler_cuenta).toBe('1005');
  });

  it('⭐ el orden es TOTAL: a igual prioridad desempata el id, no el orden del SELECT', () => {
    const a = cuentaPorRegla(mov('CB013'), [r(10, 'CB', 'AAA'), r(10, 'CB', 'BBB')]);
    const b = cuentaPorRegla(mov('CB013'), [r(10, 'CB', 'BBB'), r(10, 'CB', 'AAA')]);
    // Sin desempate, dos cargas mandarían el dinero a cuentas distintas según cómo viniera la query.
    expect(a).toEqual(b);
  });

  it('el eje que no declara matcher es comodín, no un "no aplica"', () => {
    // match_tipo null = vale para ingreso y gasto; el beneficiario sigue decidiendo.
    const v = cuentaPorRegla(mov('GN001'), [r(10, '^GN001$', '1010', '001', null)]);
    expect(v.ok).toBe(true);
  });

  it('un movimiento sin importe no es confirmable (y lo dice)', () => {
    const v = cuentaPorRegla(mov('CB013', 0), [r(10, '^CB013$', '1005')]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toBe('sin_monto');
  });

  it('una regla a medias (sin concepto) no se aplica: media cuenta no contabiliza', () => {
    const rota = { ...r(10, '^CB013$', '1005'), kepler_concepto: '' };
    expect(cuentaPorRegla(mov('CB013'), [rota]).ok).toBe(false);
  });
});

describe('aplicaPatron — el regex viene de la base, no del código', () => {
  it('sin patrón es comodín; con texto vacío no aplica', () => {
    expect(aplicaPatron(null, 'lo que sea')).toBe(true);
    expect(aplicaPatron('^CB', null)).toBe(false);
  });

  it('⛔ [negativa] un patrón INVÁLIDO no aplica en vez de reventar la clasificación entera', () => {
    expect(() => aplicaPatron('([a-z', 'abc')).not.toThrow();
    expect(aplicaPatron('([a-z', 'abc')).toBe(false);
  });

  it('⛔ [negativa] un patrón más largo que el tope no aplica (corre en NUESTRO proceso)', () => {
    expect(aplicaPatron('a'.repeat(REGLA_MAX_PATRON + 1), 'aaa')).toBe(false);
  });

  it('no distingue mayúsculas: el beneficiario del ERP viene en las dos formas', () => {
    expect(aplicaPatron('^botanas', 'BOTANAS PAU')).toBe(true);
  });
});

describe('resumirLote — una fila que falla no tumba a las demás', () => {
  const montos = new Map([['a', 100], ['b', 200], ['c', 300], ['d', 400]]);
  const filas: FilaLote[] = [
    { origen_ref: 'a', estado: 'guardado', folio: 'CI-2026-00001' },
    { origen_ref: 'b', estado: 'duplicado', motivo: 'ya estaba aplicado' },
    { origen_ref: 'c', estado: 'guardado', folio: 'CI-2026-00002' },
    { origen_ref: 'd', estado: 'no_confirmable', motivo: 'sin_cuenta' },
  ];

  it('⭐ los que sí entraron se guardan aunque otros fallen', () => {
    const r = resumirLote(filas, montos);
    expect(r.guardados).toBe(2);
    expect(r.duplicados).toBe(1);
    expect(r.no_confirmables).toBe(1);
  });

  it('⭐ el total suma SÓLO lo guardado — un total optimista es una mentira', () => {
    const r = resumirLote(filas, montos);
    expect(r.monto_guardado).toBe(400);   // 100 + 300, NO los 1,000 del lote
  });

  it('el duplicado se cuenta aparte del rechazo: no es un error de nadie', () => {
    const r = resumirLote(filas, montos);
    expect(r.duplicados).toBe(1);
    expect(r.rechazados).toBe(0);
  });

  it('un lote vacío no rompe ni inventa totales', () => {
    const r = resumirLote([], new Map());
    expect(r.guardados).toBe(0);
    expect(r.monto_guardado).toBe(0);
  });
});

describe('evaluarDescuadre — se guarda lo contado y se levanta el hallazgo', () => {
  it('lo que cuadra al centavo no levanta nada', () => {
    expect(evaluarDescuadre('00|1', 23658, 23658).hay).toBe(false);
    expect(evaluarDescuadre('00|1', 23658, 23658.004).hay).toBe(false);   // dentro de epsilon
  });

  it('⭐ si falta, lo dice con el signo y el monto', () => {
    const d = evaluarDescuadre('00|0027628', 23658, 23400);
    expect(d.hay).toBe(true);
    expect(d.diferencia).toBe(-258);
    expect(d.resumen).toContain('falta');
    expect(d.resumen).toContain('258.00');
  });

  it('si sobra también, con el otro signo', () => {
    const d = evaluarDescuadre('00|1', 100, 150);
    expect(d.diferencia).toBe(50);
    expect(d.resumen).toContain('sobra');
  });

  it('⛔ la llave es ESTABLE: correrlo dos veces no puede crear dos hallazgos', () => {
    const a = evaluarDescuadre('00|0027628', 100, 90);
    const b = evaluarDescuadre('00|0027628', 100, 80);   // otro conteo, MISMO documento
    expect(a.dedup_key).toBe(b.dedup_key);
    expect(a.dedup_key).toBe('caja_entrega|00|0027628');
  });

  it('la tolerancia es un centavo, la misma del arqueo', () => {
    expect(LOTE_EPSILON).toBe(0.005);
    expect(evaluarDescuadre('00|1', 100, 100.01).hay).toBe(true);
  });

  it('⛔ [negativa] un EGRESO no puede dedupear contra el ingreso del mismo documento', () => {
    // Los dos signos comparten `origen_ref` cuando el ERP reusa el folio. Si la clase no entrara en
    // la llave, el segundo hallazgo se tragaría contra el primero y uno de los dos descuadres
    // desaparecería sin que nadie lo viera.
    const ing = evaluarDescuadre('00|X-D-26|0000029|0011', 100, 90, 'caja_entrega');
    const egr = evaluarDescuadre('00|X-D-26|0000029|0011', 100, 90, 'caja_egreso');
    expect(ing.dedup_key).not.toBe(egr.dedup_key);
    expect(egr.dedup_key).toBe('caja_egreso|00|X-D-26|0000029|0011');
  });

  it('el texto del egreso no habla de "el cobro": no hay cobro que contar', () => {
    const d = evaluarDescuadre('00|X-D-26|1|0011', 100, 80, 'caja_egreso');
    expect(d.resumen).toContain('El documento');
    expect(d.resumen).not.toContain('cobro');
  });
});

describe('rankearFrecuentes — lo que se repite se ofrece, la casualidad no', () => {
  const u = (cuenta: string, concepto: string, usos: number, glosa = '', ultimo = '2026-09-01'): UsoGasto =>
    ({ kepler_cuenta: cuenta, kepler_concepto: concepto, glosa, beneficiario: null, usos, ultimo_uso: ultimo });

  it('ordena por uso y numera el rango', () => {
    const r = rankearFrecuentes([u('1005', '1', 26, 'bot pau'), u('1010', '1', 27, 'nom 35 efectivo')]);
    expect(r[0].glosa).toBe('nom 35 efectivo');
    expect(r[0].rango).toBe(1);
    expect(r[1].rango).toBe(2);
  });

  it('⛔ [negativa] lo que no llega al mínimo NO se ofrece', () => {
    const r = rankearFrecuentes([u('1005', '1', FRECUENTE_MIN_USOS - 1, 'casualidad')]);
    expect(r).toHaveLength(0);
  });

  it('⭐ el orden es ESTABLE: dos cargas ofrecen lo mismo en el mismo lugar', () => {
    // Mismo uso y misma fecha: sin desempate total, el orden bailaría entre cargas y la persona
    // tocaría el chip equivocado por memoria muscular — mandando dinero a otra cuenta.
    const base = [u('1010', '2', 20, 'zzz'), u('1005', '1', 20, 'aaa'), u('1005', '1', 20, 'bbb')];
    const a = rankearFrecuentes(base).map((x) => x.kepler_cuenta + '/' + x.glosa);
    const b = rankearFrecuentes([...base].reverse()).map((x) => x.kepler_cuenta + '/' + x.glosa);
    expect(a).toEqual(b);
  });

  it('a igual uso, gana el más reciente', () => {
    const r = rankearFrecuentes([u('1005', '1', 10, 'viejo', '2026-01-01'), u('1010', '1', 10, 'nuevo', '2026-09-20')]);
    expect(r[0].glosa).toBe('nuevo');
  });

  it('un par a medias (sin concepto) no se ofrece: media cuenta no contabiliza', () => {
    const r = rankearFrecuentes([{ ...u('1005', '', 40, 'x'), kepler_concepto: '' }]);
    expect(r).toHaveLength(0);
  });

  it('respeta el límite y no rompe con lista vacía', () => {
    const muchos = Array.from({ length: 30 }, (_, i) => u('100' + i, '1', 10 + i));
    expect(rankearFrecuentes(muchos, 5)).toHaveLength(5);
    expect(rankearFrecuentes([])).toEqual([]);
  });
});

/**
 * CG — el freno de la fecha futura.
 *
 * Nace de un hecho, no de una hipótesis: `CG-2026-00002` entró al libro de prod el 2026-09-28 con
 * `fecha = 2026-12-10`. El documento era `X-D-26 0001298`, un gasto de ENERO que Kepler fechó en
 * diciembre — su propio concepto lo dice: "GASTOS NF MORELIA 28-01-2026". La pantalla lo rotulaba
 * desde seis días antes y el rótulo no frenaba: el libro terminó publicando 1 de 2 movimientos.
 */
describe('esFechaFutura — el documento fechado adelante no se confirma en lote', () => {
  const HOY = '2026-09-29';

  it('⛔ [negativa] los 8 casos medidos del ERP son futuros contra el día de México', () => {
    // Las fechas reales que `analytics.mv_caja_movimientos` tenía el 2026-09-29.
    for (const f of ['2026-12-01', '2026-12-10', '2026-12-14']) {
      expect(esFechaFutura(f, HOY)).toBe(true);
    }
  });

  it('hoy NO es futuro — el corte es estricto, si no la caja no podría cerrarse en su propio día', () => {
    expect(esFechaFutura(HOY, HOY)).toBe(false);
  });

  it('el pasado nunca es futuro: corregir hacia atrás sigue siendo legítimo', () => {
    expect(esFechaFutura('2026-01-28', HOY)).toBe(false);
  });

  it('acepta un timestamp o un Date sin que el huso corra el día', () => {
    expect(esFechaFutura('2026-12-10T00:00:00.000Z', HOY)).toBe(true);
    // ⚠️ Un `Date` construido con componentes locales: con `toISOString()` un 29-sep a las 19:00 de
    // México se lee como 30-sep UTC y esto se pondría rojo. Por eso el motor NO usa toISOString.
    expect(esFechaFutura(new Date(2026, 8, 29, 19, 0, 0), HOY)).toBe(false);
  });

  it('sin fecha o sin día de referencia NO afirma nada — no inventa un veredicto', () => {
    expect(esFechaFutura(null, HOY)).toBe(false);
    expect(esFechaFutura(undefined, HOY)).toBe(false);
    expect(esFechaFutura('', HOY)).toBe(false);
    expect(esFechaFutura('2026-12-10', '')).toBe(false);
  });

  it('una fecha ilegible no se toma por futura', () => {
    expect(esFechaFutura('10/12/2026', HOY)).toBe(false);
  });

  it('el motivo tiene texto propio: la persona tiene que saber QUÉ corregir', () => {
    expect(TEXTO_NO_CONFIRMABLE.fecha_futura).toMatch(/fecha/i);
    // Exhaustividad: si mañana se agrega un motivo y nadie le escribe el texto, esto se pone rojo.
    for (const t of Object.values(TEXTO_NO_CONFIRMABLE)) expect(t.length).toBeGreaterThan(20);
  });
});

/**
 * `[CG.27-B.1]` El CV del importe es lo ÚNICO que discrimina para decidir qué proponerle a un
 * beneficiario. La cadencia no sirve: medida entre días distintos, la mediana es 2-5 días para
 * TODOS los recurrentes, así que "lo esperado hoy" no separa a nadie.
 */
describe('cvDe — estabilidad del importe', () => {
  it('importe siempre igual → 0, que es la señal más fuerte que hay acá', () => {
    expect(cvDe([500, 500, 500])).toBe(0);
  });

  it('separa a los estables de los erráticos, con los valores medidos en prod', () => {
    // CAPITAN DE MARCA da 0.36 y GASTOS GENERALES OFICINAS 4.39: dos mundos.
    const estable = cvDe([100, 110, 95, 105])!;
    // ⚠️ La forma errática real NO es "valores muy distintos": es **muchos chicos y uno enorme**,
    // que es como se ve una caja chica. Mi primer fixture ([10, 5000, 80, 30000]) daba 1.64 y la
    // prueba salió roja — inventar números para una aserción de umbral no prueba el umbral.
    const erratico = cvDe([50, 40, 60, 55, 45, 50, 40, 60, 50, 12000])!;
    expect(estable).toBeLessThan(0.6);
    expect(erratico).toBeGreaterThan(2);
  });

  it('⛔ [negativa] con menos de dos muestras devuelve null, NO 0', () => {
    // Un 0 significa "siempre el mismo importe". Confundirlo con "no se pudo medir" haría
    // proponer importes sobre nada.
    expect(cvDe([500])).toBeNull();
    expect(cvDe([])).toBeNull();
    expect(cvDe(null)).toBeNull();
  });

  it('⛔ [negativa] con media cero devuelve null en vez de dividir por cero', () => {
    expect(cvDe([0, 0, 0])).toBeNull();
    expect(cvDe([-50, 50])).toBeNull();
  });

  it('descarta valores no finitos en vez de propagar NaN', () => {
    expect(cvDe([100, NaN, 100, Infinity] as number[])).toBe(0);
  });
});

describe('propuestaDe — la cuenta que la contabilidad ya usó', () => {
  const h = (usos: number, tot: number) => ({ cuenta: '606-014', concepto: '074', usos, tot });

  it('con soporte y dominancia suficientes, propone el par con su respaldo', () => {
    // El caso real de CAPITAN DE MARCA en prod: 447 usos, dominancia 1.00.
    const p = propuestaDe(h(447, 447))!;
    expect(p.kepler_cuenta).toBe('606-014');
    expect(p.kepler_concepto).toBe('074');
    expect(p.soporte).toBe(447);
    expect(p.dominancia).toBe(1);
  });

  it('⛔ [negativa] soporte insuficiente NO propone — mismos umbrales que el autorrelleno', () => {
    expect(propuestaDe(h(2, 2))).toBeNull();
  });

  it('⛔ [negativa] dominancia repartida NO propone: un beneficiario con tres cuentas no determina ninguna', () => {
    expect(propuestaDe(h(4, 10))).toBeNull();      // 0.40
    expect(propuestaDe(h(5, 10))).toBeNull();      // 0.50
    expect(propuestaDe(h(6, 10))).not.toBeNull();  // 0.60, el umbral exacto
  });

  it('⛔ [negativa] sin historia, o con media cuenta, NO propone', () => {
    expect(propuestaDe(null)).toBeNull();
    expect(propuestaDe(undefined)).toBeNull();
    expect(propuestaDe({ cuenta: '606-014', concepto: '', usos: 99, tot: 99 })).toBeNull();
    expect(propuestaDe({ cuenta: '', concepto: '074', usos: 99, tot: 99 })).toBeNull();
  });
});

describe('CAIDO_DIAS — cuándo un recurrente cuenta como caído', () => {
  it('son 21 días, y no 30, porque el hueco normal llega a 17', () => {
    // Con 30 se perderían los 11 que hoy están caídos en prod.
    expect(CAIDO_DIAS).toBe(21);
  });
});
