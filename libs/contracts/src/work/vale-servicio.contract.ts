/**
 * `[MDT.1.5]` Vale de servicio — contrato (Fase MDT, D8/D8b; tablas `platform.work_order*`).
 *
 * La constancia de un servicio que una persona atiende y firma: qué se pidió, para qué área, qué se hizo,
 * con qué materiales, y hasta tres firmas. NO es la Mesa de Servicio. Las reglas que deciden (qué
 * transición vale desde qué estado, qué falta para cerrar) viven aquí, puras y con pruebas, y el servidor
 * las aplica; la base además cobra las invariantes con CHECK y triggers.
 */

export const ESTADOS_VALE = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export type EstadoVale = (typeof ESTADOS_VALE)[number];

export const PAPELES_FIRMA = ['performed', 'reviewed', 'received'] as const;
export type PapelFirma = (typeof PAPELES_FIRMA)[number];

export const ACCIONES_VALE = ['take', 'assign', 'complete', 'cancel', 'reopen'] as const;
export type AccionVale = (typeof ACCIONES_VALE)[number];

/** Quién pide la acción, visto por el servidor (la llave y su relación con ESTE vale). */
export interface QuienActua {
  user_id: string;
  puede_atender: boolean;
  puede_gestionar: boolean;
}

/** Lo mínimo del vale que deciden las reglas. */
export interface ValeParaReglas {
  status: EstadoVale;
  requested_by: string | null;
  assigned_to: string | null;
  work_detail: string | null;
}

/**
 * ¿Puede esta persona hacer esta acción sobre este vale ahora? Devuelve el motivo del NO (para el 403 o
 * 409 y para apagar el botón con su porqué), o `null` si puede.
 *  · tomar     — sólo un vale ABIERTO; quien atiende o coordina.
 *  · asignar   — abierto o en proceso; sólo quien coordina.
 *  · completar — en proceso (o abierto: quien lo cierra lo toma); el asignado o quien coordina; exige el
 *                detalle del trabajo (como MDTask). Ninguna firma es obligatoria (D8b).
 *  · cancelar  — abierto o en proceso; quien coordina, o quien lo pidió mientras sigue ABIERTO.
 *  · reabrir   — completado o cancelado; sólo quien coordina (y con motivo, lo exige el servidor).
 */
export function motivoNoPuede(accion: AccionVale, v: ValeParaReglas, q: QuienActua): string | null {
  const esAsignado = !!v.assigned_to && v.assigned_to === q.user_id;
  const esSolicitante = !!v.requested_by && v.requested_by === q.user_id;
  switch (accion) {
    case 'take':
      if (v.status !== 'open') return 'Sólo se toma un vale abierto.';
      return q.puede_atender || q.puede_gestionar ? null : 'Tomar un vale es de quien atiende.';
    case 'assign':
      if (v.status !== 'open' && v.status !== 'in_progress') return 'Sólo se asigna un vale abierto o en proceso.';
      return q.puede_gestionar ? null : 'Asignar es de quien coordina los vales.';
    case 'complete':
      if (v.status !== 'open' && v.status !== 'in_progress') return 'Este vale ya está cerrado.';
      if (!(esAsignado || q.puede_gestionar || (v.status === 'open' && q.puede_atender))) {
        return 'Lo cierra quien lo atiende o quien coordina.';
      }
      return (v.work_detail ?? '').trim() ? null : 'Escribe el trabajo que se hizo para cerrarlo.';
    case 'cancel':
      if (v.status !== 'open' && v.status !== 'in_progress') return 'Este vale ya está cerrado.';
      if (q.puede_gestionar || (esSolicitante && v.status === 'open')) return null;
      return 'Lo cancela quien coordina, o quien lo pidió mientras sigue abierto.';
    case 'reopen':
      if (v.status !== 'completed' && v.status !== 'cancelled') return 'Sólo se reabre un vale cerrado.';
      return q.puede_gestionar ? null : 'Reabrir es de quien coordina los vales.';
    default:
      return 'Acción desconocida.';
  }
}

/** ¿Puede capturar el trabajo (detalle, materiales, resultado, notas)? El asignado o quien coordina, con el vale vivo. */
export function puedeEditarTrabajo(v: ValeParaReglas, q: QuienActua): boolean {
  if (v.status !== 'open' && v.status !== 'in_progress') return false;
  return (!!v.assigned_to && v.assigned_to === q.user_id) || q.puede_gestionar;
}

/** Folio impreso: seis dígitos, como el talonario de papel de MDTask. */
export function folioVale(folio: number): string {
  return String(Math.max(0, Math.trunc(folio))).padStart(6, '0');
}

export interface FirmaVale {
  id: string;
  role: PapelFirma;
  signer_name: string;
  signed_on: string;
  signed_at: string | null;
  url: string | null;
}

export interface EventoVale {
  kind: string;
  from_status: EstadoVale | null;
  to_status: EstadoVale | null;
  note: string | null;
  actor_name: string | null;
  at: string;
}

export interface ValeResumen {
  id: string;
  folio: number;
  status: EstadoVale;
  service_date: string;
  requesting_area: string;
  warehouse_code: string | null;
  activity: string;
  requester_name: string;
  assignee_name: string | null;
  assigned_to: string | null;
  created_at: string;
  /** Firmas vivas, de las tres posibles. */
  firmas: number;
  source: 'suite' | 'mdtask';
}

export interface ValeDetalle extends ValeResumen {
  location_detail: string | null;
  requested_by: string | null;
  supervisor_id: string | null;
  supervisor_name: string | null;
  work_detail: string | null;
  materials_used: string | null;
  outcome: string | null;
  follow_up_notes: string | null;
  general_notes: string | null;
  needs_follow_up: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  firmas_detalle: FirmaVale[];
  eventos: EventoVale[];
  /** Lo que ESTA persona puede hacer ahora, con el porqué de lo que no (para apagar botones con razón). */
  acciones: Record<AccionVale, string | null>;
  puede_editar_trabajo: boolean;
  puede_firmar: boolean;
}

export interface ListaVales {
  /** `mine` = los que pedí o me asignaron · `queue` = abiertos sin dueño · `all` = todos (quien coordina). */
  scope: 'mine' | 'queue' | 'all';
  scopes_permitidos: ('mine' | 'queue' | 'all')[];
  vales: ValeResumen[];
  /** Si el servidor topó la lista: cuántos hay en total en ese alcance. */
  total: number;
  has_more: boolean;
}

export interface NuevoVale {
  requesting_area: string;
  activity: string;
  warehouse_code?: string | null;
  location_detail?: string | null;
  /** Por omisión, quien lo levanta. */
  requester_name?: string | null;
  supervisor_id?: string | null;
}

export interface CambiosTrabajoVale {
  work_detail?: string | null;
  materials_used?: string | null;
  outcome?: string | null;
  follow_up_notes?: string | null;
  general_notes?: string | null;
  needs_follow_up?: boolean | null;
}

export interface FirmarVale {
  role: PapelFirma;
  signer_name: string;
  /** `data:image/png;base64,…` del trazo. */
  image_base64: string;
}

/** Valida un vale nuevo; devuelve el motivo del primer error o `null`. */
export function validarNuevoVale(b: Partial<NuevoVale> | null | undefined): string | null {
  const area = (b?.requesting_area ?? '').trim();
  const act = (b?.activity ?? '').trim();
  if (!area) return 'Escribe el área que lo pide.';
  if (area.length > 120) return 'El área va en 120 caracteres o menos.';
  if (!act) return 'Escribe qué se necesita.';
  if (act.length > 300) return 'Lo que se necesita va en 300 caracteres o menos.';
  if ((b?.location_detail ?? '').length > 200) return 'El lugar va en 200 caracteres o menos.';
  return null;
}
