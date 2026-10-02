import { HttpErrorResponse } from '@angular/common/http';
import type { SdRequestDetail } from '@megadulces/contracts';
import { IMPACT_LABEL, PRIORITY_LABEL, STATUS_LABEL, sdError, slaTexto } from './service-desk.service';
import { SD_IMPACTS, SD_PRIORITIES, SD_STATUSES } from '@megadulces/contracts';

type Sla = SdRequestDetail['sla'];
const NOW = Date.parse('2026-10-02T15:00:00.000Z');
const en = (min: number) => new Date(NOW + min * 60_000).toISOString();
const sla = (over: Partial<Sla> = {}): Sla => ({
  first_response_due_at: null, due_at: en(120), first_responded_at: null, paused: false,
  first_breached: false, resolution_breached: false, used_ratio: 0.1, ...over,
});

describe('[MS.3] etiquetas: cubren TODO el vocabulario del contrato', () => {
  // Si el servidor agrega un estado/prioridad/impacto y la pantalla no lo conoce, pintaría `undefined`.
  it('prioridades, estados e impactos tienen etiqueta', () => {
    for (const p of SD_PRIORITIES) expect(PRIORITY_LABEL[p]).toBeTruthy();
    for (const s of SD_STATUSES) expect(STATUS_LABEL[s]).toBeTruthy();
    for (const i of SD_IMPACTS) expect(IMPACT_LABEL[i]).toBeTruthy();
  });
});

describe('[MS.3] slaTexto', () => {
  it('lo que ya terminó no muestra plazo: no se vencen los resueltos, cerrados ni cancelados', () => {
    for (const s of ['resuelto', 'cerrado', 'cancelado'] as const) expect(slaTexto(sla({ due_at: en(-500) }), s, NOW)).toEqual({ texto: '—', tono: 'mute' });
  });
  it('⭐ un ticket en pausa dice «En pausa», no un vencimiento que no corre', () => {
    expect(slaTexto(sla({ paused: true, due_at: en(-999) }), 'en_espera', NOW)).toEqual({ texto: 'En pausa', tono: 'mute' });
  });
  it('sin plazo se declara, no se inventa un «vence»', () => {
    expect(slaTexto(sla({ due_at: null }), 'nuevo', NOW).texto).toBe('Sin plazo');
  });
  it('en plazo: minutos, horas o días según la distancia', () => {
    expect(slaTexto(sla({ due_at: en(30) }), 'nuevo', NOW).texto).toBe('Vence en 30 min');
    expect(slaTexto(sla({ due_at: en(180) }), 'nuevo', NOW).texto).toBe('Vence en 3 h');
    expect(slaTexto(sla({ due_at: en(60 * 24 * 4) }), 'nuevo', NOW).texto).toBe('Vence en 4 d');
  });
  it('pasado el plazo es rojo y dice hace cuánto', () => {
    expect(slaTexto(sla({ due_at: en(-90) }), 'en_proceso', NOW)).toEqual({ texto: 'Venció hace 2 h', tono: 'bad' });
  });
  it('⭐ marcado vencido por el barrido es rojo aunque el reloj local diga lo contrario', () => {
    expect(slaTexto(sla({ due_at: en(10), resolution_breached: true }), 'nuevo', NOW).tono).toBe('bad');
  });
  it('al 80 % del plazo o más avisa en amarillo', () => {
    expect(slaTexto(sla({ due_at: en(20), used_ratio: 0.85 }), 'nuevo', NOW).tono).toBe('warn');
    expect(slaTexto(sla({ due_at: en(20), used_ratio: 0.5 }), 'nuevo', NOW).tono).toBe('ok');
  });
});

describe('[MS.3] sdError: la razón del servidor se muestra tal cual', () => {
  const http = (status: number, error: unknown) => new HttpErrorResponse({ status, error });
  it('mensaje en texto o lista', () => {
    expect(sdError(http(400, { message: 'Escribe un título' }), 'x')).toBe('Escribe un título');
    expect(sdError(http(400, { message: ['a', 'b'] }), 'x')).toBe('a · b');
  });
  it('sin mensaje: 403, 413 y sin red tienen su propio texto; el resto cae al de la pantalla', () => {
    expect(sdError(http(403, null), 'x')).toContain('permiso');
    expect(sdError(http(413, null), 'x')).toContain('grande');
    expect(sdError(http(0, null), 'x')).toContain('conexión');
    expect(sdError(http(500, null), 'cayó')).toBe('cayó');
    expect(sdError(new Error('boom'), 'cayó')).toBe('cayó');
  });
});
