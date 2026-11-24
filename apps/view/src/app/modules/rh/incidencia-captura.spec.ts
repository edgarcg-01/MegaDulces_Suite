import { dia } from '../../../testing/rh.fixture';
import { COMO_LE_DICEN, TRABAJO_CORRIDO, aliasDelDia, cuerpoCaptura, etiquetaConAlias, formDelDia, formNuevo, sugerenciasDelDia, trabajoCorrido } from './incidencia-captura';

/**
 * `[RH.18.1]` `[RH.18.3]` Capturar desde el día: qué se propone y qué se llena solo. Lo que se defiende: el orden sale del
 * estado del día con lo que contestó RH (D1, 2026-11-23); ⛔ el tipo NO viene elegido (lo eligen ellas); «Horario
 * distinto» llega con lo que checó; y ⛔ nada se adivina — con una sola checada no se sabe si fue entrada o salida.
 */
const HOY = '2026-10-07';

describe('[RH.18.3] lo que contestó RH: cómo le decían en Mega Talento', () => {
  it('«Tráfico» → Horario distinto · «Cita médica» → Incapacidad · «Personal» → Permiso sin goce · «No registrada» → Otros', () => {
    expect(COMO_LE_DICEN).toEqual({ horario_distinto: 'tráfico', incapacidad: 'cita médica', permiso_sin_goce: 'personal', otros: 'no registrada' });
    expect(etiquetaConAlias('incapacidad', 'Incapacidad')).toBe('Incapacidad · cita médica');
    // Un tipo sin nombre en Mega Talento se queda como está.
    expect(etiquetaConAlias('vacaciones', 'Vacaciones')).toBe('Vacaciones');
  });
});

describe('[RH.18.3] sugerencias por día', () => {
  it('no vino (falta o sin dato): personal, cita médica y no registrada primero; nunca «Horario distinto»', () => {
    for (const estado of ['falta', 'sin_dato'] as const) {
      const s = sugerenciasDelDia(dia({ fecha: '2026-10-06', estado, entrada: null, salida: null }), '2026-10-06', HOY);
      expect(s.slice(0, 3)).toEqual(['permiso_sin_goce', 'incapacidad', 'otros']);
      expect(s).not.toContain('horario_distinto');
    }
  });

  it('un día que no ha llegado: vacaciones primero; uno pasado sin checadas que medir: personal', () => {
    expect(sugerenciasDelDia(undefined, '2026-10-09', HOY)[0]).toBe('vacaciones');
    expect(sugerenciasDelDia(undefined, '2026-10-02', HOY)[0]).toBe('permiso_sin_goce');
  });

  it('llegó tarde o salió antes: tráfico (Horario distinto); una sola checada: no registrada (Otros)', () => {
    expect(sugerenciasDelDia(dia({ atrasoMin: 25 }), '2026-10-01', HOY).slice(0, 2)).toEqual(['horario_distinto', 'otros']);
    expect(sugerenciasDelDia(dia({ salidaAntesMin: 40 }), '2026-10-01', HOY)[0]).toBe('horario_distinto');
    expect(sugerenciasDelDia(dia({ estado: 'marca_faltante', hora: '13:10' }), '2026-10-01', HOY)[0]).toBe('otros');
    expect(sugerenciasDelDia(dia({ comidaExcesoMin: 20, atrasoMin: 5 }), '2026-10-01', HOY)[0]).toBe('comida_distinta');
    expect(sugerenciasDelDia(dia({ estado: 'descanso' }), '2026-10-04', HOY)[0]).toBe('cambio_descanso');
  });
});

describe('[RH.18.1] el formulario de un día', () => {
  it('⛔ NEGATIVA — el tipo NO viene elegido (lo eligen ellas), ni desde el día ni en el panel', () => {
    expect(formDelDia('118', '2026-10-06', dia({ fecha: '2026-10-06', estado: 'falta', entrada: null, salida: null })).incident_type).toBe('');
    expect(formDelDia('118', '2026-10-01', dia({ atrasoMin: 25 })).incident_type).toBe('');
    expect(formNuevo('101', '2026-10-02')).toMatchObject({ person_code: '101', date_from: '2026-10-02', incident_type: '', entrada: '' });
  });

  it('⭐ si eligen «Horario distinto», ya trae la entrada, la salida y la comida que checó', () => {
    const f = formDelDia('118', '2026-10-01', dia({ atrasoMin: 25, entrada: '8:25', salida: '18:00', comidaMin: 45 }));
    expect([f.person_code, f.date_from]).toEqual(['118', '2026-10-01']);
    expect([f.entrada, f.salida, f.comidaDia]).toEqual(['08:25', '18:00', '45']);
    // Y lo que se manda es lo mismo que si se hubiera tecleado.
    const b = cuerpoCaptura({ ...f, incident_type: 'horario_distinto', reason: 'Tráfico', authorized_by_name: 'Jefe Prueba' }, 'PH');
    expect([b.minutes, b.end_minutes, b.break_minutes]).toEqual([505, 1080, 45]);
  });

  it('si se pasó de la comida, los minutos que tomó ya están (por si eligen «Comida distinta»)', () => {
    expect(formDelDia('118', '2026-10-01', dia({ comidaExcesoMin: 20, comidaMin: 80 })).minutos).toBe('80');
    expect(formDelDia('118', '2026-10-01', dia({ desayunoExcesoMin: 10, desayunoMin: 25 })).minutos).toBe('25');
    expect(formDelDia('118', '2026-10-01', dia({ comidaMin: 60 })).minutos).toBe('');
  });

  it('⛔ NEGATIVA — con una sola checada no adivina si fue entrada o salida: las deja vacías', () => {
    const f = formDelDia('118', '2026-10-01', dia({ estado: 'marca_faltante', entrada: '13:10', salida: null, hora: '13:10' }));
    expect([f.entrada, f.salida]).toEqual(['', undefined]);
  });
});

describe('[RH.18.7] lo que pasó ese día, arriba del globo', () => {
  it('lo dice el cálculo tal cual: falta, tarde, una checada, a tiempo, por venir', async () => {
    const { contextoDelDia } = await import('./incidencia-captura');
    expect(contextoDelDia(dia({ fecha: '2026-10-06', estado: 'falta', entrada: null, salida: null }), '2026-10-06', HOY)).toBe('No checó en todo el día.');
    expect(contextoDelDia(dia({ atrasoMin: 25, entrada: '8:25', salida: '18:00' }), '2026-10-01', HOY)).toBe('Llegó 08:25 (+25 min), salió 18:00.');
    expect(contextoDelDia(dia({ estado: 'marca_faltante', hora: '13:10', entrada: null }), '2026-10-01', HOY)).toBe('Una sola checada (13:10): no se sabe si fue entrada o salida.');
    expect(contextoDelDia(dia({}), '2026-10-01', HOY)).toBe('Checó de 08:00 a 18:00.');
    expect(contextoDelDia(undefined, '2026-10-09', HOY)).toBe('Un día que todavía no llega.');
    // ⛔ El día en curso no es falta todavía.
    expect(contextoDelDia(dia({ fecha: HOY, estado: 'falta', entrada: null, salida: null }), HOY, HOY)).toBe('Todavía no checa hoy.');
  });
});

describe('[RH.19.1] trabajó corrido: se ofrece, no se adivina', () => {
  it('⭐ sólo entrada y salida, sin comida: «Trabajó corrido» (Comida distinta) va primero', () => {
    const d = dia({ marcas: 2 });
    expect(trabajoCorrido(d)).toBe(true);
    expect(sugerenciasDelDia(d, '2026-10-01', HOY)[0]).toBe('comida_distinta');
    expect(aliasDelDia(d)).toEqual({ comida_distinta: TRABAJO_CORRIDO });
  });

  it('⛔ NEGATIVA — con su comida checada (4 marcas) no se ofrece, ni con una sola checada', () => {
    for (const d of [dia({ marcas: 4, comidaMin: 60 }), dia({ estado: 'marca_faltante', marcas: 1, salida: null })]) {
      expect(trabajoCorrido(d)).toBe(false);
      expect(aliasDelDia(d)).toEqual({});
    }
    expect(sugerenciasDelDia(dia({ marcas: 4, comidaMin: 60 }), '2026-10-01', HOY)[0]).not.toBe('comida_distinta');
  });
});
