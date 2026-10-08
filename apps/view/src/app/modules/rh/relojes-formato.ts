import type { HrRelojEstadoDto, HrSemaforoReloj } from '@megadulces/contracts';

/**
 * Fase RH · `[RH.1.7b]` — cómo se dice el estado de un reloj. Traslado de la franja de relojes de Mega Talento
 * (`src/app/rh/asistencia-resumen/asistencia-resumen.ts`: `resumenRelojes`, `peorSemaforo`, `desdeCuando`,
 * `desfaseTexto`, `faltantesTexto`, `motivoReloj`), para que RH lea lo mismo que ya conoce.
 *
 * Regla heredada: la pantalla nunca parece al día cuando no lo está. Un reloj mudo NO quiere decir que la gente
 * faltó: es falta de DATO, y por eso se dice desde cuándo y por qué, no se cuentan faltas.
 *
 * Lo que NO se trasladó, a propósito: `origenAtrasado` («el sistema que lee los relojes no toca este equipo»). En
 * Mega Talento había dos lectores en cadena; en la Suite hay uno solo (ADR-084 D3), así que el atraso de la señal
 * ya es el de la cadena entera.
 */

/** El peor estado de todos: es el que le da color a la franja. Sin relojes no hay color que dar. */
export function peorSemaforo(relojes: HrRelojEstadoDto[]): HrSemaforoReloj | 'vacio' {
  if (!relojes.length) return 'vacio';
  if (relojes.some((r) => r.semaforo === 'mudo')) return 'mudo';
  if (relojes.some((r) => r.semaforo === 'atrasado')) return 'atrasado';
  if (relojes.some((r) => r.semaforo === 'pendiente')) return 'pendiente';
  return 'ok';
}

/** «3 al día · 1 atrasado · 1 sin señal · 1 en pausa»: el resumen de una línea del encabezado. */
export function resumenRelojes(relojes: HrRelojEstadoDto[]): string {
  if (!relojes.length) return 'sin relojes registrados';
  const n = (s: HrSemaforoReloj) => relojes.filter((r) => r.semaforo === s).length;
  const partes: string[] = [];
  const ok = n('ok'), atrasados = n('atrasado'), mudos = n('mudo'), pausa = n('pendiente');
  if (ok) partes.push(`${ok} al día`);
  if (atrasados) partes.push(`${atrasados} atrasado${atrasados > 1 ? 's' : ''}`);
  if (mudos) partes.push(`${mudos} sin señal`);
  if (pausa) partes.push(`${pausa} en pausa`);
  return partes.join(' · ');
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «17 jul», en hora de México. */
function fechaCorta(iso: string): string {
  const [, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso)).split('-');
  return `${Number(d)} ${MESES[Number(m) - 1]}`;
}

/** «hace 40 s», «hace 1 h 12 m», «sin señal desde el 17 jul», «nunca ha reportado», «en pausa». */
export function desdeCuando(r: HrRelojEstadoDto): string {
  if (r.semaforo === 'pendiente') return 'en pausa';
  const s = r.segundosSinSenal;
  if (s == null) return 'nunca ha reportado';
  if (s < 90) return `hace ${Math.max(0, Math.round(s))} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return `hace ${h} h${m ? ' ' + m + ' m' : ''}`;
  }
  return r.ultimaSenal ? `sin señal desde el ${fechaCorta(r.ultimaSenal)}` : `hace ${Math.floor(s / 86400)} días`;
}

/**
 * La hora del reloj corrida más de 2 min. Es lo que convierte un retardo real en uno inventado: la tolerancia se
 * aplica sobre una hora que no es. Se corrige en el equipo, no en el sistema.
 */
export function desfaseTexto(r: HrRelojEstadoDto): string {
  const d = r.desfaseRelojSeg;
  if (d == null || Math.abs(d) <= 120) return '';
  return `hora corrida ${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) / 60)} min`;
}

/** Lo que le falta a la base contra lo que el equipo dice tener. Vacío si no se sabe; «completo» si no falta nada. */
export function faltantesTexto(r: HrRelojEstadoDto): string {
  if (r.logsEnReloj == null || r.logsEnBase == null) return '';
  const falta = r.logsEnReloj - r.logsEnBase;
  if (falta <= 0) return 'completo';
  return `faltan ${falta.toLocaleString('es-MX')}`;
}

/**
 * Por qué este reloj no está en verde, dicho de forma accionable: hay que saber si es red, equipo o trabajo de RH.
 * Un «no responde» genérico no le sirve a nadie.
 */
export function motivoReloj(r: HrRelojEstadoDto): string {
  if (r.semaforo === 'pendiente') {
    return r.nota
      ? `en pausa — ${r.nota}. Sus checadas se guardan y se aplican al quitar la pausa`
      : 'en pausa — sus checadas se guardan y se aplican al quitar la pausa';
  }
  if (r.ultimoError) return r.ultimoError;
  if (r.semaforo === 'mudo') return 'nadie ha reportado este reloj: lector apagado, equipo apagado, o sin red';
  if (r.semaforo === 'atrasado') return 'sigue llegando dato, pero más lento de lo normal';
  return '';
}

/** El chip del encabezado de Asistencia: dice si lo que se ve es de hoy. */
export function chipEnVivo(peor: HrSemaforoReloj | 'vacio'): { texto: string; tono: 'ok' | 'warn' | 'bad' | 'mute'; titulo: string } {
  if (peor === 'mudo') return { texto: 'Sin señal', tono: 'bad', titulo: 'Hay relojes sin señal: lo que se ve no es de hoy.' };
  if (peor === 'atrasado') return { texto: 'Con retraso', tono: 'warn', titulo: 'El dato sigue llegando, pero con retraso.' };
  if (peor === 'vacio') return { texto: 'Sin reloj', tono: 'mute', titulo: 'Este sitio no tiene reloj dado de alta.' };
  return { texto: 'En vivo', tono: 'ok', titulo: 'Los relojes están reportando.' };
}
