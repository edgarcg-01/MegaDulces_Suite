/**
 * [PU.VG.7] — El ritmo: ¿cuánto del presupuesto anual debería llevarse consumido a la fecha?
 *
 * Unitaria de verdad: funciones puras, sin Postgres.
 *
 * ⭐ El eje que importa es el BORDE del mes en curso. Medido contra prod el 2026-10-09: con
 * `<=` la brecha de FY2026 sale $19,903,668.37 y con `<` sale $13,653,449.54 — **46 % de
 * diferencia** por un solo carácter, sin que pasara nada en el negocio. Por eso hay una prueba
 * dedicada al renglón que cae EXACTAMENTE en el mes en curso.
 *
 * ⭐ El segundo eje son las tres ausencias, que NO son la misma y no se pueden fundir:
 *   - `sin_plan`      — la partida no tiene perfil (lo arregla quien planea);
 *   - `sin_perfil`    — el plan existe y aún no cierra un mes (no lo arregla nadie: esperar);
 *   - `desfase_plan_vs_linea` — la partida se movió después de materializar.
 * Las tres devuelven `brecha: null`, nunca 0: un cero suma en silencio y se lee como medición.
 */
import {
  perfilAcumulado,
  evaluarRitmo,
  resumirRitmo,
  llaveDePartida,
  type PlanRow,
  type LedgerRow,
} from './budget-phasing';

const plan = (ym: string, monto: unknown, cuenta = '601', suc = ''): PlanRow => ({
  account_code: cuenta,
  sucursal: suc,
  year_month: ym,
  monto,
});

const partida = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  account_code: '601',
  cost_center: '',
  concept: 'SUELDOS Y SALARIOS',
  original_amount: 300,
  reserved_amount: 0,
  committed_amount: 0,
  exercised_amount: 0,
  ...over,
});

describe('perfilAcumulado · el borde del mes en curso', () => {
  it('suma el año completo en `anual`', () => {
    const p = perfilAcumulado([plan('2026-08', 100), plan('2026-09', 100), plan('2026-10', 100)], '2026-10');
    expect(p.get('601|')!.anual).toBe(300);
    expect(p.get('601|')!.meses).toBe(3);
  });

  it('⭐ EXCLUYE el mes en curso de `hasta_mes_cerrado`', () => {
    const p = perfilAcumulado([plan('2026-08', 100), plan('2026-09', 100), plan('2026-10', 100)], '2026-10');
    expect(p.get('601|')!.hasta_mes_cerrado).toBe(200);
    expect(p.get('601|')!.meses_cerrados).toBe(2);
  });

  it('⭐ PRUEBA NEGATIVA: el renglón que cae EXACTAMENTE en el mes en curso no cuenta', () => {
    const soloEnCurso = perfilAcumulado([plan('2026-10', 999)], '2026-10');
    expect(soloEnCurso.get('601|')!.hasta_mes_cerrado).toBe(0);
    expect(soloEnCurso.get('601|')!.meses_cerrados).toBe(0);
  });

  it('un mes futuro tampoco cuenta', () => {
    const p = perfilAcumulado([plan('2026-08', 100), plan('2026-12', 500)], '2026-10');
    expect(p.get('601|')!.hasta_mes_cerrado).toBe(100);
  });

  it('separa por cuenta y por sucursal', () => {
    const p = perfilAcumulado(
      [plan('2026-08', 10, '601', ''), plan('2026-08', 20, '601', '03'), plan('2026-08', 30, '602', '')],
      '2026-10',
    );
    expect(p.size).toBe(3);
    expect(p.get('601|03')!.anual).toBe(20);
  });

  it('⚠️ un monto nulo cuenta como cero, no rompe el acumulado', () => {
    const p = perfilAcumulado([plan('2026-08', null), plan('2026-09', 100)], '2026-10');
    expect(p.get('601|')!.anual).toBe(100);
    expect(p.get('601|')!.meses).toBe(2);
  });

  it('lista vacía devuelve mapa vacío, no explota', () => {
    expect(perfilAcumulado([], '2026-10').size).toBe(0);
  });

  it('la llave de la partida empata con la del plan', () => {
    const p = perfilAcumulado([plan('2026-08', 10, '601', '03')], '2026-10');
    expect(p.has(llaveDePartida(partida({ cost_center: '03' })))).toBe(true);
  });
});

describe('evaluarRitmo · las tres ausencias NO son la misma', () => {
  it('sin perfil alguno → `sin_plan`, con brecha null (no cero)', () => {
    const r = evaluarRitmo(partida(), undefined);
    expect(r.estado).toBe('sin_plan');
    expect(r.brecha).toBeNull();
    expect(r.deberia).toBeNull();
    expect(r.motivo).toBeTruthy();
  });

  it('plan sin un mes cerrado → `sin_perfil`: ni bueno ni malo, el periodo no empezó', () => {
    const p = perfilAcumulado([plan('2026-11', 300), plan('2026-12', 0)], '2026-10');
    const r = evaluarRitmo(partida({ original_amount: 300 }), p.get('601|'));
    expect(r.estado).toBe('sin_perfil');
    expect(r.brecha).toBeNull();
  });

  it('⭐ la partida se movió después de materializar → `desfase_plan_vs_linea`', () => {
    const p = perfilAcumulado([plan('2026-08', 100), plan('2026-09', 100)], '2026-10');
    const r = evaluarRitmo(partida({ original_amount: 500 }), p.get('601|'));
    expect(r.estado).toBe('desfase_plan_vs_linea');
    expect(r.brecha).toBeNull();
    expect(r.anual_plan).toBe(200);
    expect(r.anual_linea).toBe(500);
  });

  it('una diferencia de medio centavo NO dispara el desfase', () => {
    const p = perfilAcumulado([plan('2026-08', 100), plan('2026-09', 100)], '2026-10');
    const r = evaluarRitmo(partida({ original_amount: 200.004 }), p.get('601|'));
    expect(r.estado).not.toBe('desfase_plan_vs_linea');
  });
});

describe('evaluarRitmo · el veredicto cuando SÍ se puede medir', () => {
  const perfil = () => perfilAcumulado([plan('2026-08', 100), plan('2026-09', 100), plan('2026-10', 100)], '2026-10').get('601|');

  it('⭐ el caso de prod: debería $200 y el ledger no registra un peso', () => {
    const r = evaluarRitmo(partida(), perfil());
    expect(r.estado).toBe('sin_consumo');
    expect(r.deberia).toBe(200);
    expect(r.consumido).toBe(0);
    expect(r.brecha).toBe(-200);
    expect(r.motivo).toContain('2 de 3');
  });

  it('consumir de más → `sobre_perfil`, con el porcentaje', () => {
    const r = evaluarRitmo(partida({ exercised_amount: 250 }), perfil());
    expect(r.estado).toBe('sobre_perfil');
    expect(r.brecha).toBe(50);
    expect(r.brecha_pct).toBe(25);
  });

  it('consumir de menos pero algo → `bajo_perfil`, que NO es lo mismo que sin consumo', () => {
    const r = evaluarRitmo(partida({ reserved_amount: 1 }), perfil());
    expect(r.estado).toBe('bajo_perfil');
    expect(r.consumido).toBe(1);
  });

  it('justo en el perfil → `en_ritmo`', () => {
    const r = evaluarRitmo(partida({ exercised_amount: 200 }), perfil());
    expect(r.estado).toBe('en_ritmo');
    expect(r.brecha).toBe(0);
  });

  it('el consumido suma reserva + compromiso + ejercido, y el PAGADO no entra', () => {
    const r = evaluarRitmo(
      partida({ reserved_amount: 10, committed_amount: 20, exercised_amount: 30, paid_amount: 999 } as LedgerRow),
      perfil(),
    );
    expect(r.consumido).toBe(60);
  });

  it('⚠️ Number(null) es 0 y no NaN: una columna ausente no envenena el consumido', () => {
    const r = evaluarRitmo(
      partida({ reserved_amount: null, committed_amount: undefined, exercised_amount: '40' }),
      perfil(),
    );
    expect(r.consumido).toBe(40);
    expect(Number.isNaN(r.consumido)).toBe(false);
  });

  it('⚠️ un texto que no es número no se cuela como NaN', () => {
    const r = evaluarRitmo(partida({ exercised_amount: 'n/d' }), perfil());
    expect(r.consumido).toBe(0);
  });

  it('`brecha_pct` es null cuando el denominador es 0, nunca Infinity', () => {
    const p = perfilAcumulado([plan('2026-08', 0), plan('2026-10', 300)], '2026-10');
    const r = evaluarRitmo(partida({ original_amount: 300, exercised_amount: 5 }), p.get('601|'));
    expect(r.deberia).toBe(0);
    expect(r.brecha_pct).toBeNull();
    expect(Number.isFinite(r.brecha as number)).toBe(true);
  });
});

describe('resumirRitmo · el agregado no puede inventar un cero', () => {
  it('sin nada evaluable, `brecha_total` es null y NO 0', () => {
    const filas = [evaluarRitmo(partida(), undefined), evaluarRitmo(partida(), undefined)];
    const r = resumirRitmo(filas);
    expect(r.brecha_total).toBeNull();
    expect(r.no_evaluables).toBe(2);
    expect(r.partidas).toBe(2);
  });

  it('suma sólo lo evaluable y cuenta lo que no lo es', () => {
    const p = perfilAcumulado([plan('2026-08', 100), plan('2026-09', 100)], '2026-10').get('601|');
    const filas = [
      evaluarRitmo(partida({ original_amount: 200 }), p),
      evaluarRitmo(partida({ original_amount: 200, exercised_amount: 300 }), p),
      evaluarRitmo(partida({ original_amount: 999 }), p),
    ];
    const r = resumirRitmo(filas);
    expect(r.sin_consumo).toBe(1);
    expect(r.sobre_perfil).toBe(1);
    expect(r.no_evaluables).toBe(1);
    expect(r.brecha_total).toBe(-100);
  });

  it('⛔ el resumen declara que NO hay umbral registrado: nadie debe pintar semáforo', () => {
    expect(resumirRitmo([]).umbral_registrado).toBe(false);
  });
});
