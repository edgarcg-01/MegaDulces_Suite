import {
  exigenciaParaAutorizar, puedeObservar, puedeResponder, MINIMO_TEXTO_REVISION,
} from './cash-cut.engine';

/**
 * `[CGS.17][CGS.18]` — La revisión del corte: autorizar exige respuesta y nota, y lo que no se puede
 * firmar se OBSERVA. Medido en prod el 2026-10-21: 7 cortes cerrados, 4 con esperado negativo,
 * los 7 con diferencias de cinco o seis cifras y ninguno con explicación.
 */
describe('exigenciaParaAutorizar — firmar no es dar por bueno cualquier número', () => {
  it('un corte que cuadra se autoriza sin nota', () => {
    expect(exigenciaParaAutorizar({ veredicto: 'cuadra', diferencia: 0 })).toEqual({ ok: true });
  });

  it('[negativa] un esperado imposible NO se autoriza ni con nota: se observa', () => {
    const r = exigenciaParaAutorizar({ veredicto: 'esperado_imposible', diferencia: 207486.32, nota: 'Lo autorizo igual, ya sé' });
    expect(r).toEqual({ ok: false, motivo: 'veredicto_sin_respuesta' });
  });

  it('[negativa] sin fondo medido o sellado sin veredicto, tampoco', () => {
    expect(exigenciaParaAutorizar({ veredicto: 'sin_base', diferencia: 10 }).motivo).toBe('veredicto_sin_respuesta');
    expect(exigenciaParaAutorizar({ veredicto: 'sin_medir', diferencia: null }).motivo).toBe('veredicto_sin_respuesta');
  });

  it('[negativa] con diferencia y sin nota (o nota corta) no se autoriza', () => {
    expect(exigenciaParaAutorizar({ veredicto: 'falta', diferencia: -62.45 }).motivo).toBe('falta_nota');
    expect(exigenciaParaAutorizar({ veredicto: 'sobra', diferencia: 500, nota: 'ok' }).motivo).toBe('falta_nota');
  });

  it('con diferencia y una nota de verdad, sí', () => {
    expect(exigenciaParaAutorizar({ veredicto: 'sobra', diferencia: 500, nota: 'Un billete de 500 mal clasificado' }))
      .toEqual({ ok: true });
  });

  it('un centavo de redondeo no es una diferencia', () => {
    expect(exigenciaParaAutorizar({ veredicto: 'cuadra', diferencia: 0.004 })).toEqual({ ok: true });
  });
});

describe('puedeObservar — la misma segregación que autorizar', () => {
  const cerrado = { estado: 'cerrado' as const, closed_by: 'u-cajera', created_by: 'u-cajera' };
  const motivo = 'El esperado es negativo: falta la pierna del depósito';

  it('alguien ajeno observa un corte cerrado con motivo', () => {
    expect(puedeObservar(cerrado, 'u-supervisora', ['u-cajera'], motivo)).toEqual({ ok: true });
  });

  it('[negativa] quien cerró, quien abrió o quien capturó no observan', () => {
    expect(puedeObservar(cerrado, 'u-cajera', [], motivo).motivo).toBe('misma_persona_que_cerro');
    expect(puedeObservar({ ...cerrado, created_by: 'u-abre' }, 'u-abre', [], motivo).motivo).toBe('abrio_el_corte');
    expect(puedeObservar(cerrado, 'u-supervisora', ['u-supervisora'], motivo).motivo).toBe('capturo_en_el_corte');
  });

  it(`[negativa] sin motivo de ${MINIMO_TEXTO_REVISION} caracteres no se observa`, () => {
    expect(puedeObservar(cerrado, 'u-supervisora', [], 'mal').motivo).toBe('sin_motivo');
  });

  it('[negativa] un borrador, uno ya observado o uno autorizado no se observan', () => {
    expect(puedeObservar({ estado: 'borrador' }, 'u-s', [], motivo).motivo).toBe('no_esta_cerrado');
    expect(puedeObservar({ estado: 'observado' }, 'u-s', [], motivo).motivo).toBe('ya_observado');
    expect(puedeObservar({ estado: 'autorizado' }, 'u-s', [], motivo).motivo).toBe('ya_autorizado');
  });
});

describe('puedeResponder — la caja contesta y el corte vuelve a revisión', () => {
  const observado = { estado: 'observado', observed_by: 'u-supervisora' };
  const resp = 'Faltaba registrar el depósito del banco, va en la jornada de hoy';

  it('la caja responde una observación', () => {
    expect(puedeResponder(observado, 'u-cajera', resp)).toEqual({ ok: true });
  });

  it('[negativa] quien observó no se responde a sí misma', () => {
    expect(puedeResponder(observado, 'u-supervisora', resp).motivo).toBe('quien_observo');
  });

  it('[negativa] sin observación pendiente o sin texto, no', () => {
    expect(puedeResponder({ estado: 'cerrado' }, 'u-cajera', resp).motivo).toBe('no_esta_observado');
    expect(puedeResponder(observado, 'u-cajera', '  ').motivo).toBe('sin_respuesta');
  });
});
