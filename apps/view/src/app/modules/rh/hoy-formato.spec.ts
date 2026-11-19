import { HR_HOY_NOTA_NO_CONTESTO } from '@megadulces/contracts';
import { diasParaAgendar, planDe, respuestasDe, resultadoDe } from './hoy-formato';

/**
 * `[RH.17.1]` Lo que guarda cada respuesta de la tarjeta «uno por uno». Lo que se defiende: cada botón llama a los
 * endpoints que ya existen con lo que el servidor espera, «No contestó» escribe la nota EXACTA que la regla cuenta, y
 * al cerrar a alguien primero se cambia la etapa (lo que no se puede perder) y después se anota el motivo.
 */
describe('[RH.17.1] planDe', () => {
  it('«Le interesa» en Filtro: anota el contacto y pasa a Conductual', () => {
    expect(planDe('interesa', { stage: 'filtro_inicial' })).toEqual([
      { tipo: 'evento', cuerpo: { event_type: 'contacto', channel: 'llamada', note: 'Le interesa' } },
      { tipo: 'etapa', stage: 'entrevista_rh' },
    ]);
  });

  it('«Le interesa» en la última etapa del flujo sólo anota (no hay a dónde pasar)', () => {
    expect(planDe('interesa', { stage: 'psicometria' })).toEqual([
      { tipo: 'evento', cuerpo: { event_type: 'contacto', channel: 'llamada', note: 'Le interesa' } },
    ]);
  });

  it('«No contestó» escribe la nota que la regla de «Hoy» cuenta como intento', () => {
    expect(planDe('no_contesto', { stage: 'filtro_inicial' })).toEqual([
      { tipo: 'evento', cuerpo: { event_type: 'contacto', channel: 'llamada', note: HR_HOY_NOTA_NO_CONTESTO } },
    ]);
    expect(HR_HOY_NOTA_NO_CONTESTO).toBe('No contestó');
  });

  it('«Agendé» desde Filtro pasa a Conductual; desde Conductual sólo anota', () => {
    expect(planDe('agendo', { stage: 'filtro_inicial' }, { cuando: 'jueves 20 nov 10:00' })).toEqual([
      { tipo: 'evento', cuerpo: { event_type: 'entrevista', channel: 'llamada', note: 'Entrevista agendada: jueves 20 nov 10:00' } },
      { tipo: 'etapa', stage: 'entrevista_rh' },
    ]);
    expect(planDe('agendo', { stage: 'entrevista_rh' }, { cuando: 'x' })).toHaveLength(1);
  });

  it('cerrar: primero la etapa, después el motivo', () => {
    const p = planDe('cerrar', { stage: 'entrevista_rh' }, { motivo: 'Sueldo' });
    expect(p[0]).toEqual({ tipo: 'etapa', stage: 'rechazado' });
    expect(p[1]).toEqual({ tipo: 'evento', cuerpo: { event_type: 'nota', channel: 'portal', note: 'Se cerró: Sueldo' } });
  });

  it('expediente bien: pasa a Aptitudes y lo anota; «documento mal» y «liga» no tienen plan aquí', () => {
    expect(planDe('exp_bien', { stage: 'entrevista_rh' })[0]).toEqual({ tipo: 'etapa', stage: 'aptitudes' });
    expect(planDe('exp_mal', { stage: 'entrevista_rh' })).toEqual([]);
    expect(planDe('liga_jefe', { stage: 'aptitudes' })).toEqual([]);
  });
});

describe('[RH.17.1] respuestasDe', () => {
  it('llamadas: cuatro respuestas con teclas 1–4', () => {
    expect(respuestasDe('nuevos', { stage: 'filtro_inicial', intentos_sin_respuesta: 0 }).map((r) => [r.id, r.tecla]))
      .toEqual([['interesa', '1'], ['no_contesto', '2'], ['agendo', '3'], ['cerrar', '4']]);
  });
  it('al tercer intento, «No contestó» avisa que va a preguntar si se cierra', () => {
    expect(respuestasDe('seguimiento', { stage: 'filtro_inicial', intentos_sin_respuesta: 2 }).find((r) => r.id === 'no_contesto')!.ayuda)
      .toContain('3.º intento');
  });
  it('expediente y jefe tienen sus propias respuestas', () => {
    expect(respuestasDe('expediente', { stage: 'entrevista_rh', intentos_sin_respuesta: 0 }).map((r) => r.id)).toEqual(['exp_bien', 'exp_mal']);
    expect(respuestasDe('jefe', { stage: 'aptitudes', intentos_sin_respuesta: 0 }).map((r) => r.id)).toEqual(['liga_jefe']);
  });
});

describe('[RH.17.1] resultadoDe y diasParaAgendar', () => {
  it('el resumen dice en palabras a dónde pasaron', () => {
    expect(resultadoDe('interesa', { stage: 'filtro_inicial' })).toBe('Pasaron a Conductual');
  });
  it('agenda de lunes a sábado: nunca ofrece domingo', () => {
    const sabado = new Date(2026, 10, 21);   // sábado 21-nov-2026
    const d = diasParaAgendar(sabado, 3);
    expect(d.map((x) => x.value)).toEqual(['lunes 23 nov', 'martes 24 nov', 'miércoles 25 nov']);
    expect(d.every((x) => !x.value.startsWith('domingo'))).toBe(true);
  });
});
