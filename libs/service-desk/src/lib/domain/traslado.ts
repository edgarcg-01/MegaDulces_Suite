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
