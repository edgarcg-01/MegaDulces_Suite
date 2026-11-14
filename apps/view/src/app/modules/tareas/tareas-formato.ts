import type { EstadoPunto, EstadoTareaDelDia, EvidenciaPunto, FrecuenciaTarea, MomentoTarea } from '@megadulces/contracts';

/** `[MDT.3]` Formato compartido de las pantallas de Tareas por puesto: una sola forma de decir cada estado. */

const ESTADO: Record<EstadoTareaDelDia, string> = {
  pendiente: 'Sin empezar', en_proceso: 'En proceso', entregada: 'Entregada', cancelada: 'Cancelada',
};
export const etiquetaEstado = (e: EstadoTareaDelDia): string => ESTADO[e] ?? e;

export function severidadEstado(e: EstadoTareaDelDia): 'success' | 'info' | 'warn' | 'secondary' {
  return e === 'entregada' ? 'success' : e === 'en_proceso' ? 'info' : e === 'pendiente' ? 'warn' : 'secondary';
}

const MOMENTO: Record<MomentoTarea, string> = {
  apertura: 'Apertura', operacion: 'Operación del turno', cierre: 'Cierre', supervision: 'Supervisión', administrativo: 'Administrativo',
};
export const etiquetaMomento = (m: MomentoTarea | null): string => (m ? MOMENTO[m] ?? m : 'Sin momento');

const PUNTO: Record<EstadoPunto, string> = { hecho: 'Hecho', justificado: 'Justificado', no_ejecutado: 'Falta evidencia' };
export const etiquetaPunto = (e: EstadoPunto): string => PUNTO[e] ?? e;
export function severidadPunto(e: EstadoPunto): 'success' | 'warn' | 'danger' {
  return e === 'hecho' ? 'success' : e === 'justificado' ? 'warn' : 'danger';
}

const EVIDENCIA: Record<EvidenciaPunto, string> = {
  photos: 'Foto', text: 'Por escrito', list: 'Lista de renglones', none: 'Sólo marcar',
};
export const etiquetaEvidencia = (e: EvidenciaPunto): string => EVIDENCIA[e] ?? e;

const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
export function etiquetaFrecuencia(f: FrecuenciaTarea, weekday: number | null, monthDay: number | null): string {
  switch (f) {
    case 'daily': return 'Diaria';
    case 'weekly': return `Cada ${DIAS[weekday ?? 0] || 'semana'}`;
    case 'monthly': return `Mensual, día ${monthDay}`;
    case 'biweekly': return 'Quincenal';
    case 'event': return 'Por evento';
    default: return f;
  }
}

/** `HH:mm` en hora de México de un instante ISO. */
export function horaDe(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' });
}

/** `AAAA-MM-DD` → «jueves 13 de noviembre» (`[MDT.UI.12]`: una fecha se lee, no se decodifica). */
export function fechaLarga(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd ?? '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * La hora límite común a todas las tareas, si la hay (`[MDT.UI.8]`): hoy las 51 vencen a las 23:00
 * y repetirla en cada renglón no informa nada. `null` = difieren, y cada renglón dice la suya.
 */
export function horaComun(isos: readonly string[]): string | null {
  if (!isos.length) return null;
  const h = horaDe(isos[0]);
  for (let i = 1; i < isos.length; i++) if (horaDe(isos[i]) !== h) return null;
  return h;
}

/** La fecha de hoy (o de hoy + `dias`) en hora de México, `AAAA-MM-DD`. */
export function fechaMx(dias = 0): string {
  const d = new Date(Date.now() + dias * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}
