import { SD_PRIORITIES } from '@megadulces/contracts';
import { armarAviso, llaveDeAviso, type SdEventoClave } from './notice';

const EVENTOS: SdEventoClave[] = [
  'nuevo_prioritario', 'asignado', 'comentario', 'resuelto', 'reabierto', 'cancelado', 'autocerrado',
  'sla_por_vencer', 'sla_primera_respuesta_vencida', 'sla_vencido',
];
const base = { folio: 'SRV-2026-00042', title: 'No abre el ERP', priority: 'alta' as const };

describe('armarAviso', () => {
  it('⭐ TODOS los eventos arman un aviso con el folio al frente (es lo que se busca en el correo)', () => {
    for (const event of EVENTOS) {
      const a = armarAviso({ ...base, event });
      expect(a.message).toContain('SRV-2026-00042');
      expect(a.title.length).toBeGreaterThan(0);
    }
  });
  it('lo vencido es crítico y lo informativo no lo es', () => {
    expect(armarAviso({ ...base, event: 'sla_vencido' }).severity).toBe('critical');
    expect(armarAviso({ ...base, event: 'sla_primera_respuesta_vencida' }).severity).toBe('critical');
    expect(armarAviso({ ...base, event: 'sla_por_vencer' }).severity).toBe('warn');
    expect(armarAviso({ ...base, event: 'resuelto' }).severity).toBe('info');
  });
  it('una solicitud URGENTE sin atender es crítica; una alta es sólo advertencia', () => {
    expect(armarAviso({ ...base, priority: 'urgente', event: 'nuevo_prioritario' }).severity).toBe('critical');
    expect(armarAviso({ ...base, priority: 'alta', event: 'nuevo_prioritario' }).severity).toBe('warn');
  });
  it('la prioridad urgente se escribe en mayúsculas para que no se pase por alto', () => {
    for (const p of SD_PRIORITIES) {
      const m = armarAviso({ ...base, priority: p, event: 'sla_vencido' }).message;
      expect(m).toContain(p === 'urgente' ? 'URGENTE' : p);
    }
  });
  it('recorta títulos y extractos largos', () => {
    const a = armarAviso({ ...base, title: 'x'.repeat(500), event: 'asignado' });
    expect(a.message.length).toBeLessThan(200);
    const c = armarAviso({ ...base, event: 'comentario', actor: 'Jorge', extracto: 'y'.repeat(500) });
    expect(c.message).toContain('…');
    expect(c.message.length).toBeLessThan(260);
  });
  it('colapsa saltos de línea del extracto: un aviso es de una sola línea', () => {
    const c = armarAviso({ ...base, event: 'comentario', extracto: 'línea 1\n\n línea 2\t fin' });
    expect(c.message).not.toMatch(/[\n\t]/);
  });
  it('autocerrado dice cuántos días y cómo reabrir', () => {
    const a = armarAviso({ ...base, event: 'autocerrado', dias: 3 });
    expect(a.message).toContain('3 días');
    expect(a.message.toLowerCase()).toContain('repórtalo');
  });
  it('sin actor no inventa uno', () => {
    expect(armarAviso({ ...base, event: 'asignado' }).message).not.toContain('la asignó');
    expect(armarAviso({ ...base, event: 'asignado', actor: 'Ana' }).message).toContain('la asignó Ana');
    // `[MS.3.10]` Una regla automática no es una persona: el aviso lo dice y no nombra a nadie.
    expect(armarAviso({ ...base, event: 'asignado', automatico: true }).message).toContain('se te asignó automáticamente');
    expect(armarAviso({ ...base, event: 'asignado', automatico: true, actor: 'Ana' }).message).not.toContain('la asignó Ana');
  });
});

describe('llaveDeAviso', () => {
  it('es estable y distingue evento, ticket, destinatario y discriminador', () => {
    expect(llaveDeAviso('sla_vencido', 'r1', 'u1')).toBe('sla_vencido:r1:u1');
    expect(llaveDeAviso('comentario', 'r1', 'u1', 'm9')).toBe('comentario:r1:u1:m9');
    expect(llaveDeAviso('comentario', 'r1', 'u1', 'm9')).not.toBe(llaveDeAviso('comentario', 'r1', 'u1', 'm10'));
    expect(llaveDeAviso('asignado', 'r1', 'u1', 0)).toBe('asignado:r1:u1:0');
  });
  it('⭐ NEGATIVA: el MISMO evento a DOS personas distintas genera DOS llaves (la regresión que el E2E destapó)', () => {
    // El índice único de la base no menciona al destinatario: si la llave tampoco, sólo el primero recibe el aviso.
    expect(llaveDeAviso('sla_vencido', 'r1', 'agente-1')).not.toBe(llaveDeAviso('sla_vencido', 'r1', 'agente-2'));
  });
  it('un discriminador vacío no cambia la llave', () => {
    expect(llaveDeAviso('resuelto', 'r1', 'u1', '')).toBe('resuelto:r1:u1');
    expect(llaveDeAviso('resuelto', 'r1', 'u1', null)).toBe('resuelto:r1:u1');
  });
});
