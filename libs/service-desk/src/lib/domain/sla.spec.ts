/**
 * El SLA de la Mesa de Servicio. Fechas de octubre de 2026 (México, UTC-6): lunes 5 · martes 6 ·
 * viernes 2 · sábado 3 · domingo 4. Calendario lunes–sábado 08:00–19:00; «1 día hábil» = 480 min.
 *
 * Plazos propuestos (ADR-081 §4, SIN calibrar): urgente 30 min / 4 h corrido · alta 2 h / 8 h hábiles ·
 * media 4 h / 24 h hábiles (3 días).
 */
import { localParts, type BusinessCalendar } from './business-clock';
import { evaluarSla, plazosIniciales, plazosTrasCambioDePrioridad, reanudarTrasPausa, type EntradaEvaluar, type PoliticaSla } from './sla';

const CAL: BusinessCalendar = { tz: 'America/Mexico_City', days: [1, 2, 3, 4, 5, 6], startMin: 480, endMin: 1140 };
const URGENTE: PoliticaSla = { priority: 'urgente', first_response_minutes: 30, resolution_minutes: 240, clock: 'calendar' };
const ALTA: PoliticaSla = { priority: 'alta', first_response_minutes: 120, resolution_minutes: 480, clock: 'business' };
const MEDIA: PoliticaSla = { priority: 'media', first_response_minutes: 240, resolution_minutes: 1440, clock: 'business' };

const mx = (iso: string): Date => new Date(`${iso}-06:00`);
const local = (d: Date | null): string => {
  if (!d) return 'null';
  const p = localParts(d, CAL.tz);
  return `${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(Math.floor(p.minOfDay / 60)).padStart(2, '0')}:${String(p.minOfDay % 60).padStart(2, '0')}`;
};

describe('plazosIniciales', () => {
  it('alta, lunes 09:00: primera respuesta 11:00, resolución 17:00 (8 h hábiles caben en el día)', () => {
    const p = plazosIniciales(mx('2026-10-05T09:00:00'), ALTA, CAL);
    expect(local(p.first_response_due_at)).toBe('10-05 11:00');
    expect(local(p.due_at)).toBe('10-05 17:00');
  });
  it('⭐ urgente corre CORRIDO: nace el domingo 23:00 y vence el lunes 03:00', () => {
    const p = plazosIniciales(mx('2026-10-04T23:00:00'), URGENTE, CAL);
    expect(local(p.first_response_due_at)).toBe('10-04 23:30');
    expect(local(p.due_at)).toBe('10-05 03:00');
  });
  it('media, viernes 18:00: 24 h hábiles → martes 09:00 (1 h viernes + sábado + lunes + 1 h martes)', () => {
    expect(local(plazosIniciales(mx('2026-10-02T18:00:00'), MEDIA, CAL).due_at)).toBe('10-06 09:00');
  });
});

describe('reanudarTrasPausa', () => {
  const base = {
    due_at: mx('2026-10-05T17:00:00'),
    first_response_due_at: mx('2026-10-05T11:00:00'),
    first_responded_at: null as Date | null,
  };
  it('pausa de 4 h hábiles: empuja la resolución de lunes 17:00 a martes 10:00', () => {
    const r = reanudarTrasPausa({ ...base, paused_at: mx('2026-10-05T10:00:00') }, mx('2026-10-05T14:00:00'), ALTA, CAL);
    expect(r.paused_delta_minutes).toBe(240);
    expect(local(r.due_at)).toBe('10-06 10:00');
  });
  it('empuja la primera respuesta SÓLO si todavía no se respondió', () => {
    const sin = reanudarTrasPausa({ ...base, paused_at: mx('2026-10-05T10:00:00') }, mx('2026-10-05T14:00:00'), ALTA, CAL);
    expect(local(sin.first_response_due_at)).toBe('10-05 15:00');
    const con = reanudarTrasPausa(
      { ...base, first_responded_at: mx('2026-10-05T09:30:00'), paused_at: mx('2026-10-05T10:00:00') },
      mx('2026-10-05T14:00:00'), ALTA, CAL);
    expect(local(con.first_response_due_at)).toBe('10-05 11:00');
  });
  it('⭐ una pausa que cruza el domingo NO le regala un día hábil: sábado 18:00 → lunes 09:00 son 120 min', () => {
    const r = reanudarTrasPausa({ ...base, paused_at: mx('2026-10-03T18:00:00') }, mx('2026-10-05T09:00:00'), ALTA, CAL);
    expect(r.paused_delta_minutes).toBe(120);
  });
  it('NEGATIVA: la MISMA pausa medida en reloj corrido serían 39 h — por eso se mide en el reloj de la política', () => {
    const r = reanudarTrasPausa({ ...base, paused_at: mx('2026-10-03T18:00:00') }, mx('2026-10-05T09:00:00'), { ...ALTA, clock: 'calendar' }, CAL);
    expect(r.paused_delta_minutes).toBe(39 * 60);
  });
  it('una pausa de 0 minutos no mueve nada', () => {
    const r = reanudarTrasPausa({ ...base, paused_at: mx('2026-10-05T10:00:00') }, mx('2026-10-05T10:00:00'), ALTA, CAL);
    expect(r.due_at?.getTime()).toBe(base.due_at.getTime());
    expect(r.paused_delta_minutes).toBe(0);
  });
});

describe('plazosTrasCambioDePrioridad', () => {
  it('de media a alta se recalcula desde la creación; la pausa ya acumulada se conserva', () => {
    const creado = mx('2026-10-05T09:00:00');
    const sinPausa = plazosTrasCambioDePrioridad(creado, 0, null, ALTA, CAL);
    expect(local(sinPausa.due_at)).toBe('10-05 17:00');
    const conPausa = plazosTrasCambioDePrioridad(creado, 120, null, ALTA, CAL);
    expect(local(conPausa.due_at)).toBe('10-05 19:00');
  });
});

describe('evaluarSla', () => {
  const abierto = (o: Partial<EntradaEvaluar> = {}): EntradaEvaluar => ({
    status: 'en_proceso',
    due_at: mx('2026-10-05T17:00:00'),
    first_response_due_at: mx('2026-10-05T11:00:00'),
    first_responded_at: mx('2026-10-05T09:30:00'),
    paused_at: null,
    sla_first_breached_at: null,
    sla_resolution_breached_at: null,
    ...o,
  });

  it('al 75 % del plazo todavía está «ok» (el umbral es 80 %)', () => {
    const v = evaluarSla(abierto(), mx('2026-10-05T15:00:00'), ALTA, CAL, 80);
    expect(v.estado).toBe('ok');
    expect(v.usado).toBe(0.75);
    expect(v.avisar).toBe(false);
  });
  it('al 81 % pasa a «por vencer» y pide AVISAR', () => {
    const v = evaluarSla(abierto(), mx('2026-10-05T15:30:00'), ALTA, CAL, 80);
    expect(v.estado).toBe('por_vencer');
    expect(v.avisar).toBe(true);
    expect(v.usado).toBe(0.813);
  });
  it('vencido: lo marca UNA vez (idempotente entre corridas) y ya no pide avisar', () => {
    const v = evaluarSla(abierto(), mx('2026-10-05T17:30:00'), ALTA, CAL, 80);
    expect(v.estado).toBe('vencido');
    expect(v.resolucion_vencida).toBe(true);
    expect(v.avisar).toBe(false);
    expect(v.usado).toBe(1.063);
    const otra = evaluarSla(abierto({ sla_resolution_breached_at: mx('2026-10-05T17:05:00') }), mx('2026-10-05T17:30:00'), ALTA, CAL, 80);
    expect(otra.estado).toBe('vencido');
    expect(otra.resolucion_vencida).toBe(false);
  });
  it('primera respuesta vencida: sólo si NO se respondió, y una sola vez', () => {
    const sinResp = abierto({ status: 'nuevo', first_responded_at: null });
    expect(evaluarSla(sinResp, mx('2026-10-05T11:30:00'), ALTA, CAL, 80).primera_respuesta_vencida).toBe(true);
    expect(evaluarSla({ ...sinResp, sla_first_breached_at: mx('2026-10-05T11:10:00') }, mx('2026-10-05T11:30:00'), ALTA, CAL, 80).primera_respuesta_vencida).toBe(false);
    expect(evaluarSla(abierto(), mx('2026-10-05T11:30:00'), ALTA, CAL, 80).primera_respuesta_vencida).toBe(false);
    expect(evaluarSla(sinResp, mx('2026-10-05T10:59:00'), ALTA, CAL, 80).primera_respuesta_vencida).toBe(false);
  });
  it('⭐ un ticket PAUSADO no vence aunque haya pasado de largo: su reloj está detenido', () => {
    const v = evaluarSla(abierto({ status: 'en_espera', paused_at: mx('2026-10-05T12:00:00') }), mx('2026-10-09T12:00:00'), ALTA, CAL, 80);
    expect(v.estado).toBe('pausado');
    expect(v.resolucion_vencida).toBe(false);
    expect(v.primera_respuesta_vencida).toBe(false);
  });
  it('un ticket resuelto, cerrado o cancelado ya no se evalúa', () => {
    for (const status of ['resuelto', 'cerrado', 'cancelado'] as const) {
      const v = evaluarSla(abierto({ status }), mx('2026-10-09T12:00:00'), ALTA, CAL, 80);
      expect(v.estado).toBe('terminado');
      expect(v.resolucion_vencida).toBe(false);
    }
  });
  it('sin plazo (due_at null) NO inventa un «ok»: usado queda null', () => {
    const v = evaluarSla(abierto({ due_at: null }), mx('2026-10-05T12:00:00'), ALTA, CAL, 80);
    expect(v.usado).toBeNull();
    expect(v.resolucion_vencida).toBe(false);
  });
  it('urgente (reloj corrido) vence de noche, cuando uno hábil seguiría «ok»', () => {
    const creado = mx('2026-10-05T18:00:00');
    const p = plazosIniciales(creado, URGENTE, CAL);
    const v = evaluarSla(
      { status: 'asignado', due_at: p.due_at, first_response_due_at: p.first_response_due_at, first_responded_at: creado, paused_at: null, sla_first_breached_at: null, sla_resolution_breached_at: null },
      mx('2026-10-05T23:00:00'), URGENTE, CAL, 80);
    expect(v.estado).toBe('vencido');
  });
});
