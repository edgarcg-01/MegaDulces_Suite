/**
 * CG.15 — Pruebas unitarias de la aritmética del corte (ADR-070).
 *
 * El caso que más importa es el que parece trivial: **un corte sin contar NO cuadra**.
 * Si devolviera `cuadra` (0 contra 0), el día que nadie contó se vería idéntico al día que
 * cuadró al centavo, y esa es exactamente la clase de mentira que esta fase existe para matar.
 */
import {
  calcularCorte, puedeAutorizar, puedeCerrar, puedeCancelarse, motivoCancelacionValido,
  buildFolioCorte, redondea, CORTE_EPSILON, type MovimientoDelCorte,
} from './cash-cut.engine';

const m = (tipo: MovimientoDelCorte['tipo'], monto: number, estado?: string): MovimientoDelCorte =>
  ({ tipo, monto, estado });

describe('calcularCorte', () => {
  it('esperado = fondo + ingresos − gastos − depósitos', () => {
    const t = calcularCorte({
      fondoInicial: 500,
      movimientos: [m('ingreso', 1000), m('gasto', 300), m('deposito', 200)],
      conteo: [{ denominacion: 1000, piezas: 1 }],
    });
    expect(t.ingresos).toBe(1000);
    expect(t.gastos).toBe(300);
    expect(t.depositos).toBe(200);
    expect(t.esperado).toBe(1000); // 500 + 1000 − 300 − 200
  });

  it('el depósito al banco RESTA de la caja (salió el efectivo)', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [m('deposito', 100)], conteo: [] });
    expect(t.esperado).toBe(-100);
  });

  it('un movimiento cancelado NO entra, y se reporta cuántos se ignoraron', () => {
    const t = calcularCorte({
      fondoInicial: 0,
      movimientos: [m('ingreso', 100), m('ingreso', 999, 'cancelado')],
      conteo: [{ denominacion: 100, piezas: 1 }],
    });
    expect(t.ingresos).toBe(100);
    expect(t.movimientos).toBe(1);
    expect(t.cancelados).toBe(1);
    expect(t.veredicto).toBe('cuadra');
  });

  it('[negativa] SIN CONTEO el veredicto es sin_contar, NUNCA cuadra', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [], conteo: [] });
    expect(t.veredicto).toBe('sin_contar');
    expect(t.veredicto).not.toBe('cuadra');
    // y no se inventa un contado de 0 que parezca un conteo real
    expect(t.contado).toBe(0);
    expect(t.diferencia).toBe(0);
  });

  it('[negativa] un conteo con todas las piezas en 0 tampoco es un conteo', () => {
    const t = calcularCorte({
      fondoInicial: 100, movimientos: [],
      conteo: [{ denominacion: 500, piezas: 0 }, { denominacion: 100, piezas: 0 }],
    });
    expect(t.veredicto).toBe('sin_contar');
  });

  it('sólo morralla YA es un conteo: se contó algo', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [], conteo: [], morralla: 3.5 });
    expect(t.veredicto).toBe('sobra');
    expect(t.contado).toBe(3.5);
  });

  it('distingue SOBRA de FALTA por el signo', () => {
    const sobra = calcularCorte({ fondoInicial: 100, movimientos: [], conteo: [{ denominacion: 200, piezas: 1 }] });
    expect(sobra.veredicto).toBe('sobra');
    expect(sobra.diferencia).toBe(100);

    const falta = calcularCorte({ fondoInicial: 500, movimientos: [], conteo: [{ denominacion: 100, piezas: 1 }] });
    expect(falta.veredicto).toBe('falta');
    expect(falta.diferencia).toBe(-400);
  });

  it('tolera un centavo, no dos', () => {
    const ok = calcularCorte({ fondoInicial: 100, movimientos: [], conteo: [{ denominacion: 100, piezas: 1 }], morralla: CORTE_EPSILON * 0.9 });
    expect(ok.veredicto).toBe('cuadra');
    const no = calcularCorte({ fondoInicial: 100, movimientos: [], conteo: [{ denominacion: 100, piezas: 1 }], morralla: 0.05 });
    expect(no.veredicto).toBe('sobra');
  });

  it('el redondeo a centavos evita descuadres de punto flotante', () => {
    expect(redondea(0.1 + 0.2)).toBe(0.3);
    const t = calcularCorte({
      fondoInicial: 0, movimientos: [m('ingreso', 0.3)],
      conteo: [{ denominacion: 0.1, piezas: 1 }, { denominacion: 0.2, piezas: 1 }],
    });
    expect(t.veredicto).toBe('cuadra');
  });

  it('sin movimientos y sin fondo, con conteo en cero piezas, no revienta', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [], conteo: null });
    expect(t.esperado).toBe(0);
    expect(t.veredicto).toBe('sin_contar');
  });
});

describe('puedeAutorizar — ⛔ la doble llave', () => {
  const cerrado = { estado: 'cerrado' as const, closed_by: 'u-capturista' };

  it('otra persona SÍ puede autorizar', () => {
    expect(puedeAutorizar(cerrado, 'u-gerente')).toEqual({ ok: true });
  });

  it('[negativa] quien cerró NO puede autorizar', () => {
    const r = puedeAutorizar(cerrado, 'u-capturista');
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('misma_persona_que_cerro');
  });

  it('[negativa] un corte en borrador no se autoriza: primero se cierra', () => {
    expect(puedeAutorizar({ estado: 'borrador' }, 'u-gerente').motivo).toBe('no_esta_cerrado');
  });

  it('[negativa] uno ya autorizado no se vuelve a autorizar', () => {
    expect(puedeAutorizar({ estado: 'autorizado', closed_by: 'u-a' }, 'u-b').motivo).toBe('ya_autorizado');
  });

  it('[negativa] sin usuario identificado, no', () => {
    expect(puedeAutorizar(cerrado, null).motivo).toBe('sin_usuario');
    expect(puedeAutorizar(cerrado, '').motivo).toBe('sin_usuario');
  });
});

describe('puedeCerrar', () => {
  const totales = (v: string) => ({ veredicto: v } as never);

  it('un borrador con conteo se puede cerrar', () => {
    expect(puedeCerrar({ estado: 'borrador' }, 'u1', totales('cuadra'))).toEqual({ ok: true });
  });

  it('se puede cerrar aunque NO cuadre — el faltante se registra, no se esconde', () => {
    expect(puedeCerrar({ estado: 'borrador' }, 'u1', totales('falta')).ok).toBe(true);
  });

  it('[negativa] sin conteo no se cierra: sería firmar un papel en blanco', () => {
    expect(puedeCerrar({ estado: 'borrador' }, 'u1', totales('sin_contar')).motivo).toBe('sin_conteo');
  });

  it('[negativa] uno ya cerrado no se re-cierra', () => {
    expect(puedeCerrar({ estado: 'cerrado' }, 'u1', totales('cuadra')).motivo).toBe('no_es_borrador');
  });
});

describe('cancelación', () => {
  it('el motivo exige sustancia', () => {
    expect(motivoCancelacionValido('Capturado con el monto equivocado')).toBe(true);
    expect(motivoCancelacionValido('ups')).toBe(false);
    expect(motivoCancelacionValido('     ')).toBe(false);
    expect(motivoCancelacionValido(null)).toBe(false);
  });

  it('un movimiento suelto se puede cancelar', () => {
    expect(puedeCancelarse({ estado: 'registrado', corte_id: null })).toBe(true);
  });

  it('uno en un corte todavía en BORRADOR también', () => {
    expect(puedeCancelarse({ estado: 'en_corte', corte_id: 'c1' }, 'borrador')).toBe(true);
  });

  it('[negativa] uno que ya entró a un corte CERRADO no: movería un cuadre firmado', () => {
    expect(puedeCancelarse({ estado: 'en_corte', corte_id: 'c1' }, 'cerrado')).toBe(false);
    expect(puedeCancelarse({ estado: 'en_corte', corte_id: 'c1' }, 'autorizado')).toBe(false);
  });

  it('[negativa] uno ya cancelado no se cancela dos veces', () => {
    expect(puedeCancelarse({ estado: 'cancelado' })).toBe(false);
  });
});

describe('buildFolioCorte', () => {
  it('formatea con 5 dígitos', () => {
    expect(buildFolioCorte(2026, 1)).toBe('CC-2026-00001');
    expect(buildFolioCorte(2026, 12345)).toBe('CC-2026-12345');
  });
  it('[negativa] un consecutivo inválido revienta en vez de inventar', () => {
    expect(() => buildFolioCorte(2026, 0)).toThrow(/consecutivo/);
    expect(() => buildFolioCorte(2026, -1)).toThrow(/consecutivo/);
  });
});
