/**
 * `[RH.1.6]` Las reglas de las incidencias: qué se acepta al capturar, quién da cada paso y qué
 * banderas ve la auditoría. La separación de funciones se prueba también al revés.
 */
import { banderasDe, rechazoDelPaso, validarCaptura, tipoIncidencia, type Actor, type EstadoActual } from './incidencias';

const base = { site_code: 'corporativo', person_code: '15', date_from: '2026-07-07' };

describe('captura', () => {
  it('vacaciones de una semana se aceptan; "hasta" vacío es un solo día', () => {
    const r = validarCaptura({ ...base, incident_type: 'vacaciones', date_to: '2026-07-13', note: 'folio 33' });
    expect(r.ok && [r.valor.date_from, r.valor.date_to]).toEqual(['2026-07-07', '2026-07-13']);
    const uno = validarCaptura({ ...base, incident_type: 'permiso_con_goce', note: 'x' });
    expect(uno.ok && uno.valor.date_to).toBe('2026-07-07');
  });
  it('rechaza un tipo inventado, fechas al revés y un periodo de más de un año (dedazo en el año)', () => {
    expect(validarCaptura({ ...base, incident_type: 'vacasiones' }).ok).toBe(false);
    expect(validarCaptura({ ...base, incident_type: 'vacaciones', date_to: '2026-07-01' }).ok).toBe(false);
    expect(validarCaptura({ ...base, incident_type: 'vacaciones', date_to: '2062-07-07' }).ok).toBe(false);
  });
  it('horas extra exige minutos entre 1 y 720', () => {
    expect(validarCaptura({ ...base, incident_type: 'horas_extra', minutes: 0 }).ok).toBe(false);
    const r = validarCaptura({ ...base, incident_type: 'horas_extra', minutes: 90, note: 'x' });
    expect(r.ok && r.valor.minutes).toBe(90);
  });
  it('horario distinto: un solo día, hora, motivo y quién autorizó; el motivo encabeza la nota', () => {
    const sinMotivo = { ...base, incident_type: 'horario_distinto', minutes: 600, authorized_by_name: 'Jefe' };
    expect(validarCaptura(sinMotivo).ok).toBe(false);
    expect(validarCaptura({ ...sinMotivo, reason: 'cubrió la tarde', authorized_by_name: '' }).ok).toBe(false);
    expect(validarCaptura({ ...sinMotivo, reason: 'cubrió la tarde', date_to: '2026-07-08' }).ok).toBe(false);
    expect(validarCaptura({ ...sinMotivo, reason: 'x', minutes: '' }).ok).toBe(false);
    const ok = validarCaptura({ ...sinMotivo, reason: 'cubrió la tarde', note: 'checó 10:04', base_schedule_minutes: 480 });
    expect(ok.ok && [ok.valor.note, ok.valor.base_schedule_minutes]).toEqual(['cubrió la tarde — checó 10:04', 480]);
  });
  it('"Otros" exige motivo', () => {
    expect(validarCaptura({ ...base, incident_type: 'otros' }).ok).toBe(false);
  });
  it('el catálogo decide qué excusa una falta: horario distinto y amonestación no', () => {
    expect(['vacaciones', 'horas_extra', 'otros', 'horario_distinto', 'amonestacion', 'falta_injustificada']
      .map((t) => tipoIncidencia(t)?.excusaFalta)).toEqual([true, true, true, false, false, false]);
  });
});

describe('pasos y separación de funciones', () => {
  const capturo = 'aaaaaaaa-0000-0000-0000-000000000001';
  const califico = 'aaaaaaaa-0000-0000-0000-000000000002';
  const auditora = 'aaaaaaaa-0000-0000-0000-000000000003';
  const actual = (status: EstadoActual['status'], over: Partial<EstadoActual> = {}): EstadoActual => ({
    status, created_by: capturo, created_by_name: 'captura', rated_by: califico, rated_by_name: 'califica', ...over,
  });
  const quien = (id: string, p: Partial<Actor> = {}): Actor => ({ id, nombre: id, puedeCalificar: false, puedeAuditar: false, ...p });

  it('calificar exige la clave y el estado capturada', () => {
    expect(rechazoDelPaso('calificar', actual('capturada'), quien(califico), '')?.status).toBe(403);
    expect(rechazoDelPaso('calificar', actual('capturada'), quien(califico, { puedeCalificar: true }), '')).toBeNull();
    expect(rechazoDelPaso('calificar', actual('cerrada'), quien(califico, { puedeCalificar: true }), '')?.status).toBe(409);
  });
  it('rechazar y anular exigen motivo', () => {
    expect(rechazoDelPaso('rechazar', actual('capturada'), quien(califico, { puedeCalificar: true }), ' ')?.status).toBe(400);
    expect(rechazoDelPaso('anular', actual('calificada'), quien(califico, { puedeCalificar: true }), '')?.status).toBe(400);
  });
  it('quien capturó puede quitar SU captura sin calificar, pero no una ya calificada', () => {
    expect(rechazoDelPaso('anular', actual('capturada'), quien(capturo), 'me equivoqué')).toBeNull();
    expect(rechazoDelPaso('anular', actual('calificada'), quien(capturo), 'me equivoqué')?.status).toBe(403);
  });
  it('auditar: sólo lo cerrado, y NUNCA quien capturó o calificó', () => {
    const aud = { puedeAuditar: true };
    expect(rechazoDelPaso('auditar', actual('cerrada'), quien(auditora, aud), '')).toBeNull();
    expect(rechazoDelPaso('auditar', actual('cerrada'), quien(califico, aud), '')?.status).toBe(409);
    expect(rechazoDelPaso('auditar', actual('cerrada'), quien(capturo, aud), '')?.status).toBe(409);
    expect(rechazoDelPaso('auditar', actual('calificada'), quien(auditora, aud), '')?.status).toBe(409);
    expect(rechazoDelPaso('auditar', actual('cerrada'), quien(auditora), '')?.status).toBe(403);
  });
  it('lo histórico de Mega Talento (sólo nombres) también se separa, por nombre', () => {
    const hist = actual('cerrada', { created_by: null, created_by_name: 'rh@megadulces.com', rated_by: null, rated_by_name: 'rh@megadulces.com' });
    const misma = { id: auditora, nombre: 'RH@megadulces.com', puedeCalificar: false, puedeAuditar: true };
    expect(rechazoDelPaso('auditar', hist, misma, '')?.status).toBe(409);
  });
});

describe('banderas para la auditoría', () => {
  const fila = {
    incident_type: 'vacaciones', minutes: null, base_schedule_minutes: null,
    created_by: 'u1', created_by_name: 'ana', rated_by: null, rated_by_name: null,
    note: 'folio 1', created_at: '2026-07-08T10:00:00-06:00', date_to: '2026-07-07',
  };
  it('una captura limpia no levanta banderas', () => {
    expect(banderasDe(fila)).toEqual([]);
  });
  it('autocalificada, sin nota y retroactiva', () => {
    expect(banderasDe({ ...fila, rated_by: 'u1', note: '', created_at: '2026-07-20T10:00:00-06:00' }).sort())
      .toEqual(['autocalificada', 'retroactiva', 'sin_nota']);
  });
  it('horario distinto que corre la entrada una hora, y el tercero en 30 días', () => {
    expect(banderasDe({ ...fila, incident_type: 'horario_distinto', minutes: 600, base_schedule_minutes: 540, hd_30d: 3, note: '' }).sort())
      .toEqual(['corrimiento_60', 'hd_frecuente']);
  });
});
