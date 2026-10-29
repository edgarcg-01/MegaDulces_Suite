import { avisoAnunciable } from './aviso-solicitud';

const alerta = (event: string, extra: Record<string, unknown> = {}) => ({
  type: 'service_desk', severity: 'info' as const, title: 'Nueva solicitud', message: 'SRV-2026-00042 · No abre el ERP',
  data: { source: 'service_desk', event, request_id: 'abc-123', folio: 'SRV-2026-00042' }, ...extra,
});

describe('[MS.AVISO] avisoAnunciable', () => {
  it('⭐ una solicitud nueva se anuncia y lleva al detalle en la bandeja', () => {
    const a = avisoAnunciable(alerta('nueva_solicitud'));
    expect(a).not.toBeNull();
    expect(a!.route).toBe('/servicio/bandeja?id=abc-123');
    expect(a!.urgente).toBe(false);
  });
  it('una prioritaria CRÍTICA (urgente) se marca para que no se cierre sola; una alta no', () => {
    expect(avisoAnunciable(alerta('nuevo_prioritario', { severity: 'critical' }))!.urgente).toBe(true);
    expect(avisoAnunciable(alerta('nuevo_prioritario', { severity: 'warn' }))!.urgente).toBe(false);
  });
  it('NEGATIVA: los demás avisos de la mesa NO abren ventana (siguen en la campana)', () => {
    for (const e of ['comentario', 'asignado', 'resuelto', 'reabierto', 'levantada', 'sla_vencido', 'autocerrado', 'transferido']) {
      expect(avisoAnunciable(alerta(e))).toBeNull();
    }
  });
  it('NEGATIVA: una alerta de OTRO tipo no se anuncia aunque traiga el mismo evento', () => {
    expect(avisoAnunciable(alerta('nueva_solicitud', { type: 'db_health' }))).toBeNull();
  });
  it('sin request_id lleva a la bandeja en general, y un id raro no rompe la URL', () => {
    expect(avisoAnunciable(alerta('nueva_solicitud', { data: { event: 'nueva_solicitud' } }))!.route).toBe('/servicio/bandeja');
    expect(avisoAnunciable(alerta('nueva_solicitud', { data: { event: 'nueva_solicitud', request_id: 'a b&c' } }))!.route).toBe('/servicio/bandeja?id=a%20b%26c');
  });
  it('un data ausente o nulo no lanza', () => {
    expect(avisoAnunciable({ type: 'service_desk', severity: 'info', title: 't', message: 'm', data: null })).toBeNull();
    expect(avisoAnunciable({ type: 'service_desk', severity: 'info', title: 't', message: 'm' })).toBeNull();
  });
});
