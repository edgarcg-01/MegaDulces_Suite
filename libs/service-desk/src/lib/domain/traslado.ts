/**
 * `[MS.7.11]` Transferir un ticket a otra cola (decisión M6). Función pura: decide si se puede y en qué estado queda.
 *
 * Transferir MUEVE el mismo ticket (mismo folio, mismo hilo, mismos adjuntos; no clona): cambia cola y categoría, quita la
 * asignación y recalcula los plazos con la política de la cola nueva. La prioridad que una persona ya confirmó se CONSERVA: el modelo
 * de la cola nueva pide datos que el ticket quizá no tiene (¿hay riesgo para personas?) y recalcularla sería inventarlos.
 *
 * ⛔ Lo que impide perder un ticket:
 *  · la cola destino debe tener al menos UNA persona que pueda atenderla (si no, el ticket queda en una cola que nadie ve);
 *  · la categoría debe ser DE la cola destino (si no, el ticket diría una cosa y viviría en otra);
 *  · un ticket resuelto o cerrado no se traslada (no hay nada que atender) — se reabre primero;
 *  · hace falta decir por qué: es lo que se lee en el hilo de las dos áreas.
 */
import type { SdStatus } from '@megadulces/contracts';

export interface EntradaTraslado {
  status: SdStatus;
  origenId: string;
  destinoId: string;
  /** La cola destino existe, está encendida y no está dada de baja. */
  destinoActiva: boolean;
  /** La categoría elegida existe, está activa y pertenece a la cola destino. */
  categoriaEsDelDestino: boolean;
  /** Cuántas personas pueden atender la cola destino hoy (miembros activos con permiso). */
  miembrosDestino: number;
  motivo: string;
  /** `[MSH.2]` El ticket de origen es confidencial / la cola destino es confidencial. Ausente = no (lo de siempre). */
  origenConfidencial?: boolean;
  destinoConfidencial?: boolean;
}

/** `400` = lo que se pidió está mal; `409` = lo pedido no cabe en el estado de las cosas. */
export interface ErrorTraslado {
  http: 400 | 409;
  mensaje: string;
}

const NO_SE_TRASLADA: readonly SdStatus[] = ['resuelto', 'cerrado', 'cancelado'];

export function validarTraslado(e: EntradaTraslado): ErrorTraslado | null {
  if (!e.motivo.trim()) return { http: 400, mensaje: 'Indica por qué se traslada a otra área: es lo que leerán las dos' };
  if (NO_SE_TRASLADA.includes(e.status)) return { http: 409, mensaje: 'Una solicitud resuelta o cerrada no se traslada: reábrela primero si sigue sin resolverse' };
  if (e.origenId === e.destinoId) return { http: 400, mensaje: 'La solicitud ya está en esa área: elige otra' };
  if (!e.destinoActiva) return { http: 400, mensaje: 'El área destino no existe o no está disponible' };
  if (!e.categoriaEsDelDestino) return { http: 400, mensaje: 'La categoría debe ser una de las del área destino' };
  /*
   * `[MSH.2]` R3 (confirmada por Sistemas el 2026-10-06): un ticket CONFIDENCIAL no sale a un área que no lo es —los miembros de esa
   * área verían un ticket de RH— y uno normal tampoco entra a una confidencial —quedaría con la marca equivocada—. La base ya lo
   * impide (trigger, 23514), pero un 500 no explica nada: aquí se dice. Entre las coordinadoras de RH se usa REASIGNAR, no trasladar.
   */
  if ((e.origenConfidencial === true) !== (e.destinoConfidencial === true)) {
    return e.origenConfidencial === true
      ? { http: 409, mensaje: 'Una solicitud confidencial no se traslada a un área que no es confidencial. Para pasarla entre quienes atienden esa área, reasígnala.' }
      : { http: 409, mensaje: 'Una solicitud normal no se traslada a un área confidencial: levanta una solicitud nueva ahí, para que nazca confidencial.' };
  }
  if (e.miembrosDestino < 1) return { http: 409, mensaje: 'Nadie atiende hoy esa área: la solicitud quedaría sin que nadie la vea. Pide que sumen a alguien a la cola primero' };
  return null;
}

/**
 * El estado con el que queda el ticket: SIEMPRE `nuevo` (sin asignar, en la fila de la cola destino). La asignación se quita y la base
 * exige asignado para `asignado` y `en_proceso`.
 *
 * ⛔ Uno que estaba EN ESPERA no puede quedarse en espera: sin asignado no podría reanudarse (la base exige asignado en `en_proceso`) y
 * quedaría atorado. Por eso el traslado TERMINA la espera: se acredita el tiempo que ya estuvo en pausa, el motivo se limpia y el área
 * destino recibe el ticket con el reloj corriendo — si lo que se esperaba sigue pendiente, lo vuelve a poner en espera con SU motivo.
 */
export function estadoTrasTraslado(_status: SdStatus): SdStatus {
  return 'nuevo';
}

/** ¿El traslado termina una espera? (hay que cerrar la pausa: acreditar el tiempo, limpiar el motivo, soltar el reloj). */
export function terminaEspera(status: SdStatus): boolean {
  return status === 'en_espera';
}

export interface ColaParaTraslado {
  id: string;
  code: string;
  name: string;
  confidential: boolean | null;
  /** La lista de puestos que pueden LEVANTAR en la cola (`[MSP.2.1]`). Aquí se ignora a propósito y no sale. */
  requester_positions?: readonly string[] | null;
}
export interface CategoriaParaTraslado {
  id: string;
  queue_id: string;
  name: string;
}

/**
 * `[MSP.5.0]` A dónde se puede trasladar: las colas (ya filtradas a encendidas) que tienen al menos una categoría, con sus categorías.
 *
 * ⛔ NO aplica la lista de puestos de «Nueva solicitud»: trasladar no es levantar (D8). Medido el 2026-11-24: el diálogo de traslado
 * leía el catálogo de «Nueva solicitud», que le esconde Presupuestos a la coordinación de TI y de Mantenimiento, así que no podían
 * mandarle una reposición aunque el servidor la aceptaba. Las demás reglas (confidencial, alguien que la atienda, la cola actual) las
 * decide `validarTraslado` en el servidor, con su mensaje; esta lista sólo dice qué áreas existen para trasladar.
 * La lista de puestos es interna: no sale en la respuesta.
 */
export function destinosDeTraslado(
  colas: readonly ColaParaTraslado[],
  categorias: readonly CategoriaParaTraslado[],
): { queues: { id: string; code: string; name: string; confidential: boolean }[]; categories: CategoriaParaTraslado[] } {
  const conCategorias = new Set(categorias.map((c) => c.queue_id));
  const queues = colas.filter((q) => conCategorias.has(q.id)).map((q) => ({ id: q.id, code: q.code, name: q.name, confidential: q.confidential === true }));
  const ofrecidas = new Set(queues.map((q) => q.id));
  return { queues, categories: categorias.filter((c) => ofrecidas.has(c.queue_id)).map((c) => ({ id: c.id, queue_id: c.queue_id, name: c.name })) };
}
