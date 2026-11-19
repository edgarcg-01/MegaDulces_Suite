/**
 * `[MSP.1]` Las reglas de un área como «Presupuestos y Requerimientos». Funciones PURAS: sin base, sin red.
 * Plan y decisiones: `docs/IMPLEMENTACION/FASES/FASE_MSP_PRESUPUESTOS_Y_REQUERIMIENTOS.md`.
 *
 * Todo se decide por VALORES de la cola (D5), nunca por su nombre: `requester_positions`, `requires_description`,
 * `requires_decision`, `work_order_queue_codes`. La próxima área que los necesite es configuración.
 *
 *  · Quién levanta (D1): si la cola trae lista de puestos, el puesto del TITULAR debe estar en ella —también cuando quien atiende
 *    la levanta a nombre de otra persona—. Sin lista, cualquiera (lo de siempre).
 *  · El dictamen (D2): autorizado / no autorizado, con motivo, sólo de la coordinación de ESA cola. No cambia el estado: resolver
 *    sigue siendo un paso aparte y, en una cola que lo exige, sin dictamen no se resuelve.
 *  · La orden de servicio (D3): una solicitud HIJA en otra cola de la lista. Exige dictamen AUTORIZADO (si la cola lo exige) y
 *    que el padre esté vivo y tomado. El padre espera (`orden_servicio`) y se resuelve solo cuando ya no hay órdenes abiertas y al
 *    menos una se resolvió.
 */
import { SD_DECISIONS, type SdDecision, type SdStatus } from '@megadulces/contracts';

/** `400` = lo pedido está mal · `403` = no le toca a quien lo pide · `409` = no cabe en el estado de las cosas. */
export interface ErrorPresupuesto {
  http: 400 | 403 | 409;
  mensaje: string;
}

const ABIERTOS: readonly SdStatus[] = ['nuevo', 'asignado', 'en_proceso', 'en_espera'];
const TERMINADOS: readonly SdStatus[] = ['resuelto', 'cerrado'];
const SIN_DICTAMEN: readonly SdStatus[] = ['resuelto', 'cerrado', 'cancelado'];

/** `[MSP.1.1]` ¿El puesto del titular puede levantar en esta cola? `null` = la cola no restringe. */
export function puedeLevantarEnCola(puestoTitular: string | null | undefined, puestosDeLaCola: readonly string[] | null | undefined): boolean {
  if (!puestosDeLaCola) return true;
  return !!puestoTitular && puestosDeLaCola.includes(puestoTitular);
}

/**
 * `[MSP.1.1]` ¿La cola se OFRECE en «Nueva solicitud» a esta persona? A quien puede levantar en ella, y a quien es miembro de la
 * cola (la levanta a nombre de alguien que sí puede). El god-mode NO entra por ser god-mode: se le ofrecería algo que el servidor le
 * rechaza para sí mismo.
 */
export function colaSeOfrece(puesto: string | null | undefined, puestosDeLaCola: readonly string[] | null | undefined, esMiembro: boolean): boolean {
  return esMiembro || puedeLevantarEnCola(puesto, puestosDeLaCola);
}

/** El mensaje del 403 cuando el puesto no está en la lista: dice QUIÉN sí puede, con los nombres de los puestos. */
export function mensajeQuienLevanta(nombresDePuestos: readonly string[]): string {
  const lista = nombresDePuestos.length ? nombresDePuestos.join(', ') : 'los puestos que el área definió';
  return `Esta área sólo recibe solicitudes de: ${lista}.`;
}

/** `[MSP.1.2]` La descripción, cuando la cola la exige. */
export function validarDescripcion(exige: boolean, descripcion: string): ErrorPresupuesto | null {
  if (exige && !descripcion.trim()) return { http: 400, mensaje: 'Describe lo que necesitas: en esta área la descripción es obligatoria' };
  return null;
}

export interface EntradaDictamen {
  /** La cola de la solicitud exige dictamen (`requires_decision`). */
  colaExige: boolean;
  /** Quien lo da coordina ESA cola (clave + membresía `coordinador`; el god-mode no cuenta para un acto de negocio). */
  coordina: boolean;
  status: SdStatus;
  decision: unknown;
  nota: string;
  /** El dictamen que ya tiene (para no registrar dos veces lo mismo). */
  previo: { decision: SdDecision; nota: string } | null;
  /** Órdenes de servicio ya emitidas desde esta solicitud: con una orden en marcha, el dictamen ya no se cambia. */
  ordenes: number;
}

/** `[MSP.1.3]` ¿Se puede registrar este dictamen? */
export function validarDictamen(e: EntradaDictamen): ErrorPresupuesto | null {
  if (!e.colaExige) return { http: 409, mensaje: 'Esta área no usa dictamen' };
  if (!e.coordina) return { http: 403, mensaje: 'Sólo la coordinación de esta área da el dictamen' };
  if (typeof e.decision !== 'string' || !(SD_DECISIONS as readonly string[]).includes(e.decision)) {
    return { http: 400, mensaje: `El dictamen debe ser uno de: ${SD_DECISIONS.join(', ')}` };
  }
  if (!e.nota.trim()) return { http: 400, mensaje: 'Escribe el motivo del dictamen: es lo que leerá quien lo pidió' };
  if (SIN_DICTAMEN.includes(e.status)) return { http: 409, mensaje: 'Una solicitud resuelta, cerrada o cancelada ya no admite dictamen' };
  if (e.ordenes > 0) return { http: 409, mensaje: 'Ya hay una orden de servicio en marcha: el dictamen ya no se cambia' };
  if (e.previo && e.previo.decision === e.decision && e.previo.nota.trim() === e.nota.trim()) {
    return { http: 409, mensaje: 'La solicitud ya tiene ese dictamen' };
  }
  return null;
}

/** `[MSP.1.4]` Resolver en una cola que exige dictamen, sin dictamen → 409 (el mensaje); si no, `null`. */
export function exigeDictamenParaResolver(colaExige: boolean, decision: SdDecision | null | undefined): string | null {
  return colaExige && !decision ? 'Registra el dictamen (autorizado o no autorizado) antes de resolver esta solicitud' : null;
}

export interface EntradaOrden {
  /** Quien la pide coordina la cola del PADRE. */
  coordina: boolean;
  /** `work_order_queue_codes` de la cola del padre (`null` = no manda órdenes). */
  destinosPermitidos: readonly string[] | null;
  colaExigeDictamen: boolean;
  decision: SdDecision | null;
  padreStatus: SdStatus;
  /** El padre es, a su vez, una orden: una orden no genera órdenes (un solo nivel). */
  padreEsOrden: boolean;
  /** El `code` de la cola destino si existe y está ENCENDIDA; `null` si no. */
  destinoCode: string | null;
  destinoConfidencial: boolean;
  categoriaEsDelDestino: boolean;
  /** Personas que hoy pueden atender la cola destino. */
  miembrosDestino: number;
  /** Qué debe hacer el área destino: es la descripción de la orden. */
  instrucciones: string;
}

/** `[MSP.1.5]` ¿Se puede generar esta orden de servicio? */
export function validarOrdenDeServicio(e: EntradaOrden): ErrorPresupuesto | null {
  if (!e.coordina) return { http: 403, mensaje: 'Sólo la coordinación del área genera órdenes de servicio' };
  if (!e.destinosPermitidos?.length) return { http: 409, mensaje: 'Esta área no genera órdenes de servicio' };
  if (e.padreEsOrden) return { http: 409, mensaje: 'Una orden de servicio no genera otra orden' };
  if (e.colaExigeDictamen && e.decision !== 'autorizado') {
    return e.decision === 'no_autorizado'
      ? { http: 409, mensaje: 'Una solicitud NO autorizada no genera orden de servicio' }
      : { http: 409, mensaje: 'Primero da el dictamen: sólo una solicitud autorizada genera orden de servicio' };
  }
  if (e.padreStatus === 'nuevo') return { http: 409, mensaje: 'Toma la solicitud antes de generar la orden de servicio' };
  if (!ABIERTOS.includes(e.padreStatus)) return { http: 409, mensaje: 'Una solicitud resuelta, cerrada o cancelada ya no genera órdenes' };
  if (!e.instrucciones.trim()) return { http: 400, mensaje: 'Escribe qué debe hacer el área que recibe la orden' };
  if (!e.destinoCode || !e.destinosPermitidos.includes(e.destinoCode)) {
    return { http: 400, mensaje: 'Esa área no recibe órdenes de servicio de esta, o no está disponible' };
  }
  if (e.destinoConfidencial) return { http: 409, mensaje: 'Una orden de servicio no va a un área confidencial' };
  if (!e.categoriaEsDelDestino) return { http: 400, mensaje: 'La categoría debe ser una de las del área destino' };
  if (e.miembrosDestino < 1) return { http: 409, mensaje: 'Nadie atiende hoy esa área: la orden quedaría sin que nadie la vea' };
  return null;
}

export interface EntradaPadre {
  padreStatus: SdStatus;
  colaExigeDictamen: boolean;
  decision: SdDecision | null;
  /** El estado de TODAS las órdenes del padre, ya con el cambio que se acaba de hacer. */
  ordenes: readonly SdStatus[];
}

/**
 * `[MSP.1.6]` ¿El padre se resuelve solo? Cuando ninguna orden sigue abierta y al menos una se resolvió (una orden cancelada no
 * resuelve nada: el padre se queda esperando a que la coordinación decida). Sólo desde trabajo vivo (`en_proceso`/`en_espera`) y,
 * si la cola exige dictamen, con el dictamen autorizado.
 */
export function resolverPadrePorOrdenes(e: EntradaPadre): boolean {
  if (e.padreStatus !== 'en_proceso' && e.padreStatus !== 'en_espera') return false;
  if (e.colaExigeDictamen && e.decision !== 'autorizado') return false;
  if (e.ordenes.some((s) => ABIERTOS.includes(s))) return false;
  return e.ordenes.some((s) => TERMINADOS.includes(s));
}

/** La nota con la que el padre queda resuelto: qué órdenes lo resolvieron y cómo. */
export function notaResolucionPorOrdenes(ordenes: readonly { folio: string; area: string; status: SdStatus; nota: string | null }[]): string {
  const hechas = ordenes.filter((o) => TERMINADOS.includes(o.status));
  const partes = hechas.map((o) => `${o.folio} (${o.area})${o.nota ? `: ${o.nota}` : ''}`);
  return `Resuelta con la orden de servicio ${partes.join(' · ')}`.slice(0, 5000);
}
