/**
 * [PU.VG.8] — Las reglas que sacan al presupuesto de su propia pantalla.
 *
 * Unitaria de verdad: funciones puras, sin Postgres.
 *
 * ⭐ Los dos ejes que importan, y ninguno es «¿emite un hallazgo?»:
 *
 *   1. **El ejercicio de PRUEBA no puede emitir.** Medido en prod: FY2027 está duplicado al
 *      centavo, así que sin este freno cada hallazgo sale DOS VECES con el mismo texto y el mismo
 *      monto. Una bandeja que repite se aprende a ignorar más rápido que una vacía.
 *   2. **Un importe ausente no se publica como 0.** En una bandeja ordenada por monto, un cero
 *      manda el hallazgo al fondo: la ausencia quedaría enterrada justo donde nadie mira. Por eso
 *      el hallazgo NO se emite en vez de emitirse con cero.
 */
import {
  hallazgosDeEjercicio,
  hallazgosDePartida,
  hallazgoDeFreno,
  hallazgosDePresupuesto,
  BUDGET_RULES,
  type EjercicioMedido,
  type PartidaMedida,
} from './budget-findings.rules';

const ej = (over: Partial<EjercicioMedido> = {}): EjercicioMedido => ({
  budget_id: 'b1',
  fiscal_year: 2026,
  nombre: 'Presupuesto 2026',
  is_test: false,
  supuesto_firmado: false,
  plan_total: 1000,
  ...over,
});

const pa = (over: Partial<PartidaMedida> = {}): PartidaMedida => ({
  budget_id: 'b1',
  fiscal_year: 2026,
  is_test: false,
  line_id: 'l1',
  account_code: '601',
  concept: 'SUELDOS Y SALARIOS',
  estado: 'sin_consumo',
  deberia: 200,
  consumido: 0,
  brecha: -200,
  control_level: 'advertencia',
  original_amount: 500,
  ...over,
});

describe('hallazgosDeEjercicio · el supuesto sin firma', () => {
  it('un plan sin firma emite un hallazgo con su monto', () => {
    const r = hallazgosDeEjercicio([ej()]);
    expect(r).toHaveLength(1);
    expect(r[0].rule_key).toBe('presupuesto_supuesto_sin_firma');
    expect(r[0].importe).toBe(1000);
    expect(r[0].dedup_key).toBe('presupuesto_supuesto_sin_firma:b1');
  });

  it('un plan FIRMADO no emite nada', () => {
    expect(hallazgosDeEjercicio([ej({ supuesto_firmado: true })])).toHaveLength(0);
  });

  it('⭐ el ejercicio de PRUEBA no emite: duplicaría cada hallazgo', () => {
    expect(hallazgosDeEjercicio([ej({ is_test: true })])).toHaveLength(0);
  });

  it('⭐ sin total medido NO se emite, en vez de emitirse con importe 0', () => {
    expect(hallazgosDeEjercicio([ej({ plan_total: null })])).toHaveLength(0);
    expect(hallazgosDeEjercicio([ej({ plan_total: 0 })])).toHaveLength(0);
  });

  it('lista vacía no explota', () => {
    expect(hallazgosDeEjercicio([])).toHaveLength(0);
  });
});

describe('hallazgosDePartida · qué estado emite y cuál no', () => {
  it('⭐ el caso de prod: sin_consumo emite, con el devengado como importe', () => {
    const r = hallazgosDePartida([pa()]);
    expect(r).toHaveLength(1);
    expect(r[0].rule_key).toBe('presupuesto_partida_sin_consumo');
    expect(r[0].clase).toBe('error_captura');
    expect(r[0].importe).toBe(200);
  });

  it('sobre_perfil emite como riesgo crítico, con la BRECHA como importe', () => {
    const r = hallazgosDePartida([pa({ estado: 'sobre_perfil', consumido: 250, brecha: 50 })]);
    expect(r).toHaveLength(1);
    expect(r[0].rule_key).toBe('presupuesto_partida_sobre_perfil');
    expect(r[0].severity).toBe('critical');
    expect(r[0].importe).toBe(50);
  });

  it('⭐ los tres estados NO EVALUABLES no emiten nada: no son hallazgos, son ausencias', () => {
    for (const estado of ['sin_plan', 'sin_perfil', 'desfase_plan_vs_linea']) {
      expect(hallazgosDePartida([pa({ estado })])).toHaveLength(0);
    }
  });

  it('`en_ritmo` y `bajo_perfil` tampoco emiten', () => {
    expect(hallazgosDePartida([pa({ estado: 'en_ritmo' })])).toHaveLength(0);
    expect(hallazgosDePartida([pa({ estado: 'bajo_perfil' })])).toHaveLength(0);
  });

  it('⭐ una partida de PRUEBA no emite ni en el peor estado', () => {
    expect(hallazgosDePartida([pa({ is_test: true, estado: 'sobre_perfil', brecha: 999 })])).toHaveLength(0);
  });

  it('⚠️ sin devengado medido no emite, aunque el estado lo pida', () => {
    expect(hallazgosDePartida([pa({ deberia: null })])).toHaveLength(0);
  });

  it('⚠️ una brecha nula no se cuela como importe 0', () => {
    expect(hallazgosDePartida([pa({ estado: 'sobre_perfil', brecha: null })])).toHaveLength(0);
  });

  it('el dedup_key es por partida: dos corridas no duplican', () => {
    const a = hallazgosDePartida([pa()]);
    const b = hallazgosDePartida([pa()]);
    expect(a[0].dedup_key).toBe(b[0].dedup_key);
  });
});

describe('hallazgoDeFreno · se agrega por ejercicio, no por partida', () => {
  it('⭐ 26 partidas sin bloqueo dan UN hallazgo, no 26', () => {
    const partidas = Array.from({ length: 26 }, (_, i) => pa({ line_id: 'l' + i, original_amount: 100 }));
    const f = hallazgoDeFreno(ej(), partidas);
    expect(f).not.toBeNull();
    expect(f!.importe).toBe(2600);
    expect(f!.evidencia['partidas_sin_freno']).toBe(26);
  });

  it('si TODAS tienen bloqueo no emite', () => {
    expect(hallazgoDeFreno(ej(), [pa({ control_level: 'bloqueo' })])).toBeNull();
  });

  it('⭐ no suma partidas de OTRO ejercicio', () => {
    const f = hallazgoDeFreno(ej(), [pa({ budget_id: 'otro', original_amount: 9999 })]);
    expect(f).toBeNull();
  });

  it('⭐ no suma las de prueba, que inflarían el monto al doble', () => {
    const f = hallazgoDeFreno(ej(), [pa({ original_amount: 100 }), pa({ line_id: 'l2', is_test: true, original_amount: 100 })]);
    expect(f!.importe).toBe(100);
  });

  it('un monto ausente no suma como 0 ni envenena el total', () => {
    const f = hallazgoDeFreno(ej(), [pa({ original_amount: null }), pa({ line_id: 'l2', original_amount: 50 })]);
    expect(f!.importe).toBe(50);
  });

  it('un ejercicio de prueba nunca emite el freno', () => {
    expect(hallazgoDeFreno(ej({ is_test: true }), [pa({ is_test: true })])).toBeNull();
  });
});

describe('el lote completo y el registro de reglas', () => {
  it('junta ejercicio + partidas + freno sin perder ninguno', () => {
    const r = hallazgosDePresupuesto([ej()], [pa()]);
    const claves = r.map((x) => x.rule_key).sort();
    expect(claves).toEqual([
      'presupuesto_partida_sin_consumo',
      'presupuesto_sin_freno_duro',
      'presupuesto_supuesto_sin_firma',
    ]);
  });

  it('⭐ un ejercicio de prueba no aporta NADA al lote', () => {
    expect(hallazgosDePresupuesto([ej({ is_test: true })], [pa({ is_test: true })])).toHaveLength(0);
  });

  it('toda regla emitida está declarada en BUDGET_RULES', () => {
    const declaradas = new Set(BUDGET_RULES.map((r) => r.rule_key));
    const emitidas = hallazgosDePresupuesto([ej()], [pa(), pa({ line_id: 'l9', estado: 'sobre_perfil', brecha: 5, consumido: 9 })]);
    for (const f of emitidas) expect(declaradas.has(f.rule_key)).toBe(true);
  });

  it('las 4 reglas declaradas tienen clase y descripción', () => {
    expect(BUDGET_RULES).toHaveLength(4);
    for (const r of BUDGET_RULES) {
      expect(r.rule_key).toBeTruthy();
      expect(r.descripcion.length).toBeGreaterThan(40);
      expect(['riesgo', 'error_captura', 'oportunidad']).toContain(r.clase);
    }
  });
});
