import { dia } from '../../../testing/rh.fixture';
import { cuerpoCaptura, formDelDia, formNuevo, sugerenciasDelDia } from './incidencia-captura';

/**
 * `[RH.18.1]` Capturar desde el día: qué se propone y qué se llena solo. Lo que se defiende: el tipo propuesto sale del
 * estado del día, «Horario distinto» llega con lo que checó (para corregir, no para teclear), y ⛔ nada se adivina —
 * con una sola checada no se sabe si fue entrada o salida, y un tipo que el catálogo no tiene no se elige.
 */
const HOY = '2026-10-07';
const TODOS = ['vacaciones', 'permiso_con_goce', 'permiso_sin_goce', 'incapacidad', 'falta_injustificada', 'horario_distinto',
  'horas_extra', 'visita_fuera', 'comida_distinta', 'desayuno_distinto', 'cambio_descanso', 'descanso', 'otros'];

describe('[RH.18.1] sugerencias por día', () => {
  it('no vino (falta o sin dato): permisos primero, nunca «Horario distinto»', () => {
    for (const estado of ['falta', 'sin_dato'] as const) {
      const s = sugerenciasDelDia(dia({ fecha: '2026-10-06', estado, entrada: null, salida: null }), '2026-10-06', HOY);
      expect(s[0]).toBe('permiso_con_goce');
      expect(s).not.toContain('horario_distinto');
    }
  });

  it('un día que no ha llegado: vacaciones primero; uno pasado sin checadas que medir: permiso', () => {
    expect(sugerenciasDelDia(undefined, '2026-10-09', HOY)[0]).toBe('vacaciones');
    expect(sugerenciasDelDia(undefined, '2026-10-02', HOY)[0]).toBe('permiso_con_goce');
  });

  it('llegó tarde o salió antes: «Horario distinto»; se pasó de la comida: «Comida distinta»', () => {
    expect(sugerenciasDelDia(dia({ atrasoMin: 25 }), '2026-10-01', HOY)[0]).toBe('horario_distinto');
    expect(sugerenciasDelDia(dia({ salidaAntesMin: 40 }), '2026-10-01', HOY)[0]).toBe('horario_distinto');
    expect(sugerenciasDelDia(dia({ comidaExcesoMin: 20, atrasoMin: 5 }), '2026-10-01', HOY)[0]).toBe('comida_distinta');
    expect(sugerenciasDelDia(dia({ estado: 'descanso' }), '2026-10-04', HOY)[0]).toBe('cambio_descanso');
  });
});

describe('[RH.18.1] el formulario de un día', () => {
  it('⭐ «Horario distinto» llega con la entrada, la salida y la comida que checó', () => {
    const f = formDelDia('118', '2026-10-01', dia({ atrasoMin: 25, entrada: '8:25', salida: '18:00', comidaMin: 45 }), HOY, TODOS);
    expect([f.person_code, f.date_from, f.incident_type]).toEqual(['118', '2026-10-01', 'horario_distinto']);
    expect([f.entrada, f.salida, f.comidaDia]).toEqual(['08:25', '18:00', '45']);
    // Y lo que se manda es lo mismo que si se hubiera tecleado.
    const b = cuerpoCaptura({ ...f, reason: 'Cita médica', authorized_by_name: 'Jefe Prueba' }, 'PH');
    expect([b.minutes, b.end_minutes, b.break_minutes]).toEqual([505, 1080, 45]);
  });

  it('«Comida distinta» llega con los minutos que tomó', () => {
    const f = formDelDia('118', '2026-10-01', dia({ comidaExcesoMin: 20, comidaMin: 80 }), HOY, TODOS);
    expect([f.incident_type, f.minutos]).toEqual(['comida_distinta', '80']);
  });

  it('⛔ NEGATIVA — con una sola checada no adivina si fue entrada o salida: las deja vacías', () => {
    const f = formDelDia('118', '2026-10-01', dia({ estado: 'marca_faltante', entrada: '13:10', salida: null, hora: '13:10' }), HOY, TODOS);
    expect(f.incident_type).toBe('horario_distinto');
    expect([f.entrada, f.salida]).toEqual(['', undefined]);
  });

  it('⛔ NEGATIVA — un tipo que el catálogo no tiene no se elige: se toma el siguiente que sí', () => {
    const f = formDelDia('118', '2026-10-06', dia({ fecha: '2026-10-06', estado: 'falta', entrada: null, salida: null }), HOY, ['vacaciones', 'incapacidad']);
    expect(f.incident_type).toBe('vacaciones');
  });

  it('sin día ni sugerencias, el formulario de siempre: Vacaciones, sin horas', () => {
    expect(formNuevo('101', '2026-10-02')).toMatchObject({ person_code: '101', date_from: '2026-10-02', incident_type: 'vacaciones', entrada: '' });
  });
});
