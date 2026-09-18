/**
 * CG.17 — Pruebas unitarias del motor de autorrelleno (ADR-070 §8).
 *
 * Son unitarias de verdad: funciones puras, sin Postgres, sin HTTP, sin reloj. Lo que toca
 * Postgres se prueba aparte, corrido contra la DB (ADR-044) — `test-newdb-cash-ledger.js`.
 *
 * El eje de esta suite NO es "¿propone bien?" sino **"¿se NIEGA a proponer cuando debe?"**.
 * Un autorrelleno equivocado es peor que un campo vacío porque se acepta sin mirarlo, así
 * que la mitad de los casos de abajo son pruebas negativas.
 */
import {
  normalize, isRulePlayable, shouldSuppressRule, classifyByRules, learnConceptFromHistory,
  buildFolio, pickBest, buildProvenance, LEARNED_DEFAULTS,
  type ClassifyRule, type HistoryRow, type Proposal,
} from './caja-autofill.engine';

const rule = (o: Partial<ClassifyRule> & { id: string; priority: number }): ClassifyRule => ({
  match_tipo: null, match_glosa: null, match_beneficiario: null,
  kepler_cuenta: '601-001', kepler_concepto: '001',
  active: true, suppressed_at: null, ...o,
});

describe('normalize', () => {
  it('mayúsculas, sin acentos y espacios colapsados', () => {
    expect(normalize('  Papelería   del   mes ')).toBe('PAPELERIA DEL MES');
  });
  it('null/undefined/vacío dan cadena vacía, no revientan', () => {
    expect(normalize(null)).toBe('');
    expect(normalize(undefined)).toBe('');
  });
  it('normalizar es lo que hace que "PAPELERÍA" y "papeleria" sean la misma cosa', () => {
    expect(normalize('PAPELERÍA')).toBe(normalize('papeleria'));
  });
});

describe('classifyByRules — molde CB.6: prioridad, primera que aplica gana', () => {
  it('la de MENOR priority gana aunque las dos hagan match', () => {
    const r = classifyByRules([
      rule({ id: 'b', priority: 50, match_glosa: 'PAPELERIA', kepler_concepto: '999' }),
      rule({ id: 'a', priority: 10, match_glosa: 'PAPELERIA', kepler_concepto: '001' }),
    ], { glosa: 'Compra de papelería' });
    expect(r.value).toEqual({ kepler_cuenta: '601-001', kepler_concepto: '001' });
    expect(r.originId).toBe('a');
    expect(r.source).toBe('regla');
  });

  it('TODOS los matchers no-nulos deben cumplirse (AND, no OR)', () => {
    const rules = [rule({ id: 'a', priority: 10, match_glosa: 'PAPELERIA', match_tipo: '^gasto$' })];
    expect(classifyByRules(rules, { glosa: 'papelería', tipo: 'gasto' }).value).not.toBeNull();
    // misma glosa, otro tipo → NO aplica
    expect(classifyByRules(rules, { glosa: 'papelería', tipo: 'ingreso' }).value).toBeNull();
  });

  it('[negativa] si ninguna regla aplica NO propone, y dice por qué', () => {
    const r = classifyByRules([rule({ id: 'a', priority: 10, match_glosa: 'PAPELERIA' })], { glosa: 'Gasolina' });
    expect(r.value).toBeNull();
    expect(r.reason).toBe('sin_regla');
    expect(r.source).toBeNull();
    expect(r.confidence).toBeNull();
  });

  it('[negativa] sin reglas tampoco inventa un default', () => {
    expect(classifyByRules([], { glosa: 'lo que sea' }).value).toBeNull();
  });

  it('[negativa] una regla inactiva o suprimida NO juega', () => {
    const inactiva = classifyByRules([rule({ id: 'a', priority: 10, match_glosa: '.', active: false })], { glosa: 'x' });
    expect(inactiva.value).toBeNull();
    const suprimida = classifyByRules([rule({ id: 'a', priority: 10, match_glosa: '.', suppressed_at: new Date() })], { glosa: 'x' });
    expect(suprimida.value).toBeNull();
  });

  it('[negativa] una regla SIN ningún matcher se ignora — aplicaría a todo', () => {
    const r = classifyByRules([rule({ id: 'comodin', priority: 1 })], { glosa: 'cualquier cosa' });
    expect(r.value).toBeNull();
    expect(r.reason).toBe('sin_regla');
  });

  it('una regex inválida en la tabla NO tumba la captura: se salta esa regla', () => {
    const r = classifyByRules([
      rule({ id: 'rota', priority: 1, match_glosa: '([' }),
      rule({ id: 'buena', priority: 2, match_glosa: 'GASOLINA', kepler_concepto: '007' }),
    ], { glosa: 'Gasolina de la camioneta' });
    expect(r.originId).toBe('buena');
    expect(r.value?.kepler_concepto).toBe('007');
  });

  it('el match ignora acentos y mayúsculas del dato capturado', () => {
    const r = classifyByRules([rule({ id: 'a', priority: 1, match_beneficiario: 'GONZALEZ' })],
      { beneficiario: 'María González' });
    expect(r.value).not.toBeNull();
  });
});

describe('shouldSuppressRule — §8.5 regla 4: la que se corrige seguido se suprime sola', () => {
  it('con corrección alta y evidencia suficiente, se suprime', () => {
    expect(shouldSuppressRule(rule({ id: 'a', priority: 1, applied_count: 10, corrected_count: 4 }))).toBe(true);
  });
  it('[negativa] NO se suprime con poca evidencia — 1 de 1 no es una tendencia', () => {
    expect(shouldSuppressRule(rule({ id: 'a', priority: 1, applied_count: 1, corrected_count: 1 }))).toBe(false);
  });
  it('[negativa] una regla que casi nunca se corrige se queda', () => {
    expect(shouldSuppressRule(rule({ id: 'a', priority: 1, applied_count: 100, corrected_count: 2 }))).toBe(false);
  });
  it('una regla suprimida deja de ser jugable', () => {
    expect(isRulePlayable(rule({ id: 'a', priority: 1, suppressed_at: new Date() }))).toBe(false);
  });
});

describe('learnConceptFromHistory — §8.3: no adivina, CUENTA', () => {
  const h = (cuenta: string, concepto: string, n: number): HistoryRow =>
    ({ kepler_cuenta: cuenta, kepler_concepto: concepto, n });

  it('propone el par dominante con su soporte visible', () => {
    const r = learnConceptFromHistory([h('611-003', '002', 47), h('601-001', '001', 3)]);
    expect(r.value).toEqual({ kepler_cuenta: '611-003', kepler_concepto: '002' });
    expect(r.source).toBe('aprendido');
    expect(r.support).toBe(50);
    expect(r.supportRatio).toBeCloseTo(0.94, 2);
    expect(r.confidence).toBeCloseTo(0.94, 2);
  });

  it('suma las filas partidas del mismo par antes de decidir', () => {
    const r = learnConceptFromHistory([h('611-003', '002', 20), h('611-003', '002', 20), h('601-001', '001', 5)]);
    expect(r.value?.kepler_cuenta).toBe('611-003');
    expect(r.support).toBe(45);
  });

  it('[negativa] sin historia NO propone', () => {
    const r = learnConceptFromHistory([]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('sin_historia');
  });

  it('[negativa] con soporte por debajo del umbral NO propone — éste es el caso del §8.3', () => {
    const r = learnConceptFromHistory([h('611-003', '002', 2)]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('soporte_insuficiente');
    expect(r.support).toBe(2);
  });

  it('[negativa] "3 usos repartidos en 3 conceptos" NO es una propuesta', () => {
    const r = learnConceptFromHistory([h('a', '1', 1), h('b', '2', 1), h('c', '3', 1)]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('empate');
  });

  it('[negativa] empate exacto entre los dos primeros NO propone, aunque el soporte alcance', () => {
    const r = learnConceptFromHistory([h('a', '1', 25), h('b', '2', 25)]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('empate');
  });

  it('[negativa] dominancia por debajo del ratio mínimo NO propone', () => {
    // 11 vs 10: gana, pero con 52% — demasiado parejo para arriesgarlo.
    const r = learnConceptFromHistory([h('a', '1', 11), h('b', '2', 10)]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('empate');
    expect(r.supportRatio).toBeCloseTo(0.524, 2);
  });

  it('los umbrales son perillas, no números mágicos: bajarlos cambia el veredicto', () => {
    const rows = [h('a', '1', 2)];
    expect(learnConceptFromHistory(rows).value).toBeNull();
    expect(learnConceptFromHistory(rows, { minSupport: 1, minRatio: 0.5 }).value).toEqual({ kepler_cuenta: 'a', kepler_concepto: '1' });
    expect(LEARNED_DEFAULTS.minSupport).toBe(3);
  });

  it('el desempate es ESTABLE: el orden de las filas no cambia la propuesta', () => {
    const a = learnConceptFromHistory([h('z', '9', 10), h('a', '1', 10), h('m', '5', 30)]);
    const b = learnConceptFromHistory([h('m', '5', 30), h('a', '1', 10), h('z', '9', 10)]);
    expect(a.value).toEqual(b.value);
    expect(a.value?.kepler_cuenta).toBe('m');
  });

  it('descarta filas basura sin contaminar el conteo', () => {
    const r = learnConceptFromHistory([
      h('611-003', '002', 10),
      { kepler_cuenta: '', kepler_concepto: '002', n: 99 } as HistoryRow,
      { kepler_cuenta: '611-003', kepler_concepto: '002', n: 0 } as HistoryRow,
    ]);
    expect(r.support).toBe(10);
  });
});

describe('buildFolio — el antídoto del DMax+1', () => {
  it('formatea por tipo con 5 dígitos', () => {
    expect(buildFolio('ingreso', 2026, 1)).toBe('CI-2026-00001');
    expect(buildFolio('gasto', 2026, 42)).toBe('CG-2026-00042');
    expect(buildFolio('deposito', 2026, 12345)).toBe('CD-2026-12345');
  });
  it('[negativa] un tipo desconocido revienta en vez de inventar un prefijo', () => {
    expect(() => buildFolio('otro', 2026, 1)).toThrow(/tipo de movimiento desconocido/);
  });
  it('[negativa] un consecutivo inválido revienta — 0 o negativo no es un folio', () => {
    expect(() => buildFolio('gasto', 2026, 0)).toThrow(/consecutivo/);
    expect(() => buildFolio('gasto', 2026, 1.5)).toThrow(/consecutivo/);
  });
});

describe('pickBest — la cascada del §8.1', () => {
  const p = (o: Partial<Proposal>): Proposal => ({ value: null, source: null, confidence: null, ...o });

  it('gana el nivel de más certeza que produjo valor, no el de más confianza', () => {
    const r = pickBest(
      p({ value: 'del documento', source: 'documento', confidence: 0.8 }),
      p({ value: 'aprendido', source: 'aprendido', confidence: 0.99 }),
    );
    expect(r.value).toBe('del documento');
    expect(r.source).toBe('documento');
  });

  it('salta los niveles vacíos hasta el primero que sí propuso', () => {
    const r = pickBest(
      p({ reason: 'sin_documento' }),
      p({ value: 'aprendido', source: 'aprendido', confidence: 0.9 }),
      p({ value: 'regla', source: 'regla', confidence: 0.7 }),
    );
    expect(r.source).toBe('aprendido');
  });

  it('[negativa] si ninguno propuso devuelve el motivo MÁS informativo, no el último', () => {
    const r = pickBest(
      p({ reason: 'sin_regla' }),
      p({ reason: 'empate' }),
      p({ reason: 'sin_documento' }),
    );
    expect(r.value).toBeNull();
    // 'empate' le dice al humano que SÍ hay historia pero está repartida; 'sin_regla' no dice nada.
    expect(r.reason).toBe('empate');
  });

  it('[negativa] sin ninguna propuesta devuelve vacío con motivo, nunca un valor', () => {
    const r = pickBest();
    expect(r.value).toBeNull();
    expect(r.reason).toBeDefined();
  });
});

describe('buildProvenance — cada campo declara de dónde salió (ADR-056 / VP.2.1)', () => {
  it('guarda fuente, confianza y soporte de lo que el motor propuso', () => {
    const prov = buildProvenance({
      kepler_concepto: { value: '002', source: 'aprendido', confidence: 0.94, support: 50, supportRatio: 0.94 },
      monto: { value: 1234.5, source: 'documento', confidence: 1, originId: 'cfdi-uuid' },
    });
    expect(prov['kepler_concepto']).toEqual({ source: 'aprendido', confidence: 0.94, support: 50, support_ratio: 0.94 });
    expect(prov['monto']).toEqual({ source: 'documento', confidence: 1, origin_id: 'cfdi-uuid' });
  });

  it('[negativa] un campo que el motor NO propuso no aparece — su ausencia es la señal de que fue manual', () => {
    const prov = buildProvenance({
      glosa: { value: null, source: null, confidence: null, reason: 'sin_regla' },
      beneficiario: { value: 'Tecleado a mano', source: null, confidence: null },
    });
    expect(prov['glosa']).toBeUndefined();
    expect(Object.keys(prov)).toEqual(['beneficiario']);
  });

  it('sin propuestas devuelve objeto vacío, no null — el campo jsonb siempre es legible', () => {
    expect(buildProvenance({})).toEqual({});
  });
});
