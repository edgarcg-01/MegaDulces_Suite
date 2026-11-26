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

// ── La API de Citas (`[PQ.3.8]` C1–C2) ────────────────────────────────────────────────────────────────────────────

/** Los topes de lo que se captura: los mismos en el dominio (que rechaza) y en la pantalla (que avisa antes). */
export const LIMITES_REUNION = {
  /** = el CHECK `supplier_meetings_topics_chk`. */
  temas: 20,
  tema: 200,
  lugar: 200,
  minuta: 4000,
  motivo: 500,
  nombre: 120,
  puesto: 120,
  participantes: 30,
  /** Una reunión de más de 12 horas es un error de captura. */
  duracion_max_min: 12 * 60,
  /** Se registra una reunión que ya pasó (para escribir su minuta) hasta 90 días atrás… */
  dias_atras: 90,
  /** …y se agenda hasta dos años adelante. */
  dias_adelante: 730,
  /** Cuántas reuniones sin minuta trae la agenda (con el total siempre). */
  sin_minuta: 50,
  /** Cuántos proveedores devuelve el buscador. */
  proveedores: 20,
} as const;

/**
 * Lo que ve la persona: se DERIVA del estado y del reloj, no se guarda.
 *  - `sin_minuta`: ya terminó y nadie escribió la minuta ni la canceló. No se da por realizada (§9.1).
 */
export type SituacionReunion = 'por_confirmar' | 'agendada' | 'en_curso' | 'sin_minuta' | 'realizada' | 'cancelada';
export const SITUACIONES_REUNION: readonly SituacionReunion[] = ['por_confirmar', 'agendada', 'en_curso', 'sin_minuta', 'realizada', 'cancelada'];

export const ETIQUETA_SITUACION_REUNION: Readonly<Record<SituacionReunion, string>> = {
  por_confirmar: 'Por confirmar',
  agendada: 'Agendada',
  en_curso: 'En curso',
  sin_minuta: 'Pasó sin minuta',
  realizada: 'Realizada',
  cancelada: 'Cancelada',
};

/** Lo que se le puede hacer a una reunión según su estado y la hora (la pantalla además exige la llave de agendar). */
export type AccionReunion = 'editar' | 'confirmar' | 'minuta' | 'cancelar';

/** Un participante como lo manda la pantalla: con `id`, uno que ya estaba (al editar); sin `id`, uno nuevo. */
export interface ParticipanteDto {
  readonly id?: string | null;
  readonly side: LadoParticipante;
  readonly user_id?: string | null;
  readonly area?: AreaParticipante | null;
  readonly name?: string | null;
  readonly job_title?: string | null;
}

/**
 * `POST /compras/proveedores/citas` (agendar) y `POST …/:id/editar`. La fecha y las horas son de la Ciudad de México
 * (la base guarda el instante). Al editar, los participantes que llegan son la lista COMPLETA: el que falta se quita
 * (con fecha, no se borra) y el que cambió se quita y se agrega.
 */
export interface AgendarReunionDto {
  readonly supplier_code: string;
  readonly kind: TipoReunion;
  /** Sólo al agendar: `scheduled` (por omisión) o `to_confirm` si el ejecutivo no ha confirmado. */
  readonly status?: 'scheduled' | 'to_confirm';
  /** `AAAA-MM-DD`. */
  readonly date: string;
  /** `HH:MM`. */
  readonly start_time: string;
  /** `HH:MM`, el mismo día. */
  readonly end_time: string;
  readonly mode: ModalidadReunion;
  readonly location?: string | null;
  readonly topics?: readonly string[];
  /** Sólo y siempre en el plan de trabajo (DC12). */
  readonly work_plan_year?: number | null;
  readonly participants: readonly ParticipanteDto[];
}

export interface MinutaReunionDto {
  readonly minutes: string;
}

export interface CancelarReunionDto {
  readonly reason: string;
}

export interface ParticipanteVista {
  readonly id: string;
  readonly side: LadoParticipante;
  readonly user_id: string | null;
  /** Por Mega Dulces, el nombre de su usuario; por el proveedor, el que se capturó. */
  readonly nombre: string;
  readonly area: AreaParticipante | null;
  readonly job_title: string | null;
}

/** Otra reunión abierta, a la misma hora, con una persona de Mega Dulces que va a ésta. Avisa; no impide. */
export interface ChoqueReunion {
  readonly user_id: string;
  readonly nombre: string;
  readonly meeting_id: string;
  readonly supplier_code: string;
  readonly supplier_name: string | null;
  readonly start_time: string;
  readonly end_time: string;
}

export interface ReunionVista {
  readonly id: string;
  readonly supplier_code: string;
  /** El nombre de la ficha (la viva primero); `null` si la clave no tiene ficha: se muestra la clave. */
  readonly supplier_name: string | null;
  readonly kind: TipoReunion;
  readonly status: EstadoReunion;
  readonly situacion: SituacionReunion;
  readonly acciones: readonly AccionReunion[];
  /** Fecha y horas de la Ciudad de México. */
  readonly date: string;
  readonly start_time: string;
  readonly end_time: string;
  /** Los instantes, ISO 8601 en UTC. */
  readonly starts_at: string;
  readonly ends_at: string;
  readonly mode: ModalidadReunion;
  readonly location: string | null;
  readonly topics: readonly string[];
  readonly work_plan_year: number | null;
  readonly organizer: { readonly user_id: string; readonly nombre: string };
  readonly participants: readonly ParticipanteVista[];
  readonly minutes: string | null;
  /** Nombre de quien escribió la minuta. */
  readonly minutes_by: string | null;
  readonly minutes_at: string | null;
  readonly cancelled_reason: string | null;
  /** Nombre de quien la canceló. */
  readonly cancelled_by: string | null;
  readonly cancelled_at: string | null;
  readonly choques: readonly ChoqueReunion[];
}

/** `GET /compras/proveedores/citas?semana=AAAA-MM-DD` — la semana (lunes a domingo) y lo pendiente de antes. */
export interface AgendaCitas {
  readonly hoy: string;
  readonly semana: { readonly desde: string; readonly hasta: string };
  /** Las de la semana, por hora de inicio. */
  readonly reuniones: readonly ReunionVista[];
  /** Las que ya terminaron sin minuta ni cancelación, de CUALQUIER semana (la más vieja primero), hasta `tope`. */
  readonly sin_minuta: { readonly total: number; readonly tope: number; readonly reuniones: readonly ReunionVista[] };
  /** Las que siguen por confirmar y no han terminado, de cualquier semana. */
  readonly por_confirmar: number;
}

/** `GET /compras/proveedores/citas/:id` — la reunión y la anterior REALIZADA con el mismo proveedor (su minuta). */
export interface DetalleReunion {
  readonly reunion: ReunionVista;
  readonly anterior: ReunionVista | null;
}

/** Quién puede ir por Mega Dulces: quien ve la agenda (DC41). */
export interface PersonaCitas {
  readonly user_id: string;
  readonly nombre: string;
  readonly puesto: string;
  /** El área que se propone por su puesto; la pantalla la deja cambiar. */
  readonly area: AreaParticipante | null;
}

/** `GET /compras/proveedores/citas/opciones`. */
export interface OpcionesCitas {
  readonly personas: readonly PersonaCitas[];
}

export interface ProveedorCitas {
  readonly code: string;
  readonly name: string | null;
}

/** `GET /compras/proveedores/citas/proveedores?q=` — el buscador común (`applySmartSearch`), por nombre o clave. */
export interface ProveedoresCitas {
  readonly proveedores: readonly ProveedorCitas[];
  readonly tope: number;
}

/** Lo que regresa agendar o editar: la reunión y con quién choca a esa hora (aviso, no error). */
export interface ReunionGuardada {
  readonly id: string;
  readonly choques: readonly ChoqueReunion[];
}
