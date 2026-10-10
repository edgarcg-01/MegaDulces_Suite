import type { SdPriority, SdRequestRow } from '@megadulces/contracts';
import { PRIORITY_LABEL, slaTexto } from './service-desk.service';

/**
 * `[MSH.3]` Lo que la pantalla sabe de una cola CONFIDENCIAL (RH). Funciones puras: el servidor ya decide qué enviar (`basic`, `priority: null`);
 * esto sólo evita que la pantalla pinte lo que no hay (un chip «undefined», un plazo «Sin plazo» donde nunca habrá plazo) y dice lo que sí.
 */
export const TITULO_VISTA_LIMITADA = 'Solicitud confidencial';

/** La prioridad de una fila o `null` si el área no la usa (la API manda `priority: null`): NO se pinta chip, ni «—». */
export function etiquetaPrioridad(p: SdPriority | null | undefined): string | null {
  return p ? PRIORITY_LABEL[p] ?? null : null;
}

/** ¿La fila es la VISTA LIMITADA de un ticket confidencial (la que ve el administrador)? Todo el contenido viene vacío. */
export const esVistaLimitada = (r: { basic?: boolean } | null | undefined): boolean => r?.basic === true;

/** El título que se muestra en listas: el real, o el neutro si la fila es limitada (su `title` viene vacío). */
export const tituloVisible = (r: Pick<SdRequestRow, 'title' | 'basic'>): string => (esVistaLimitada(r) ? TITULO_VISTA_LIMITADA : r.title);

/** El plazo de una fila: sin cifra donde no hay (vista limitada, o área sin prioridad/SLA), el texto de siempre en las demás. */
export function plazoDeFila(r: Pick<SdRequestRow, 'sla' | 'status' | 'basic' | 'priority'>, now = Date.now()): { texto: string; tono: 'ok' | 'warn' | 'bad' | 'mute' } {
  if (esVistaLimitada(r) || r.priority === null) return { texto: '—', tono: 'mute' };
  return slaTexto(r.sla, r.status, now);
}

/** El aviso que se muestra ANTES de enviar a un área confidencial. Dice quién lo verá y quién NO. */
export const avisoConfidencial = (area: string | null | undefined): string =>
  `Esta solicitud será confidencial: sólo la verán tú y el equipo de ${area?.trim() || 'esta área'}. Quien administra la Mesa de Servicio no verá su contenido.`;

export const TEXTO_VISTA_LIMITADA =
  'Vista limitada: esta solicitud es confidencial. Sólo se muestran el folio, el área, el estado y las fechas; su contenido es de quien la reportó y del equipo del área.';
