/**
 * `[PQ.3.8]` Compras › Proveedores › Citas — el vocabulario de las reuniones con el proveedor.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §9.1 (DC9, DC10, DC12, DC16) y §10.15.
 * Tablas: `commercial.supplier_meetings` y `commercial.supplier_meeting_participants`. Los CHECK de esas tablas
 * aceptan EXACTAMENTE las listas de este archivo: lo vigila `database/tests/test-newdb-pq3-8-agenda-proveedor.js`.
 * Si agregas un valor aquí, agrégalo también al CHECK con una migración, o la pantalla ofrecerá algo que la base
 * rechaza.
 *
 * Sólo tipos y constantes: no lee el reloj ni la base.
 */

/** El tipo de reunión (§9.1). */
export type TipoReunion = 'executive' | 'business_review' | 'work_plan';
export const TIPOS_REUNION: readonly TipoReunion[] = ['executive', 'business_review', 'work_plan'];

export const ETIQUETA_TIPO_REUNION: Readonly<Record<TipoReunion, string>> = {
  executive: 'Cita con ejecutivo',
  business_review: 'Revisión de negocio',
  work_plan: 'Plan de trabajo',
};

/**
 * El estado de una reunión.
 *  - `to_confirm`: se ofrecieron horarios y el ejecutivo no ha elegido (la visita por WhatsApp, PQ.3.13).
 *  - `scheduled`: agendada.
 *  - `held`: realizada. ⛔ Exige la minuta: una reunión que pasó sin minuta NO se da por realizada.
 *  - `cancelled`: cancelada. Exige el motivo.
 */
export type EstadoReunion = 'to_confirm' | 'scheduled' | 'held' | 'cancelled';
export const ESTADOS_REUNION: readonly EstadoReunion[] = ['to_confirm', 'scheduled', 'held', 'cancelled'];

export const ETIQUETA_ESTADO_REUNION: Readonly<Record<EstadoReunion, string>> = {
  to_confirm: 'Por confirmar',
  scheduled: 'Agendada',
  held: 'Realizada',
  cancelled: 'Cancelada',
};

/** Cómo se reúnen. El lugar (oficina o liga) va aparte y es opcional. */
export type ModalidadReunion = 'in_person' | 'call' | 'video';
export const MODALIDADES_REUNION: readonly ModalidadReunion[] = ['in_person', 'call', 'video'];

export const ETIQUETA_MODALIDAD_REUNION: Readonly<Record<ModalidadReunion, string>> = {
  in_person: 'En persona',
  call: 'Llamada',
  video: 'Videollamada',
};

/** De qué lado va un participante. */
export type LadoParticipante = 'internal' | 'supplier';
export const LADOS_PARTICIPANTE: readonly LadoParticipante[] = ['internal', 'supplier'];

/** El área de un participante de Mega Dulces: Compras, Mercadotecnia y Finanzas agendan (DC9, DC16); Dirección asiste. */
export type AreaParticipante = 'compras' | 'marketing' | 'finanzas' | 'direccion';
export const AREAS_PARTICIPANTE: readonly AreaParticipante[] = ['compras', 'marketing', 'finanzas', 'direccion'];

export const ETIQUETA_AREA_PARTICIPANTE: Readonly<Record<AreaParticipante, string>> = {
  compras: 'Compras',
  marketing: 'Mercadotecnia',
  finanzas: 'Finanzas',
  direccion: 'Dirección',
};

/** Una reunión tal como la guarda la base (instantes ISO 8601). */
export interface ReunionProveedor {
  readonly id: string;
  /** Clave de proveedor de KEPLER (la de las reglas del Calendario y la vista PQ.3.1), no el id de la ficha. */
  readonly supplier_code: string;
  readonly kind: TipoReunion;
  readonly status: EstadoReunion;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly mode: ModalidadReunion;
  readonly location: string | null;
  /** Los temas, en el orden en que se van a tratar. */
  readonly topics: readonly string[];
  readonly organizer_user_id: string;
  /** Sólo y siempre en `work_plan` (DC12: un plan por proveedor y año). */
  readonly work_plan_year: number | null;
  readonly minutes: string | null;
  readonly minutes_by: string | null;
  readonly minutes_at: string | null;
  readonly cancelled_reason: string | null;
}

/** Un participante. Por Mega Dulces: usuario + área. Por el proveedor: nombre + puesto. */
export interface ParticipanteReunion {
  readonly id: string;
  readonly meeting_id: string;
  readonly side: LadoParticipante;
  readonly user_id: string | null;
  readonly area: AreaParticipante | null;
  readonly name: string | null;
  readonly job_title: string | null;
}
