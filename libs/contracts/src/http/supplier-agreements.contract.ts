/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos — el vocabulario de los acuerdos con el proveedor.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §9.3 y §10.20 (DC43–DC46); ADR-128.
 * Tabla: `commercial.supplier_agreements`. Los CHECK de esa tabla aceptan EXACTAMENTE las listas de este archivo: lo
 * vigila `database/tests/test-newdb-pq3-10-acuerdos.js`. Si agregas un valor aquí, agrégalo también al CHECK con una
 * migración, o la pantalla ofrecerá algo que la base rechaza.
 *
 * El acuerdo es la novena fuente del contrato único de tareas (`[OR.4]`, ADR-128): su estado ES el canónico de
 * `ESTADOS_TAREA`, sin dialecto propio.
 *
 * Sólo tipos y constantes: no lee el reloj ni la base.
 */
import type { AreaParticipante } from './supplier-meetings.contract';
import type { EstadoTarea } from '../work/task.contract';

/**
 * De qué área es el acuerdo: las de los participantes de Mega Dulces en Citas, más el proveedor.
 * ⚠️ El acuerdo del proveedor (`supplier`) también tiene responsable en la Suite: quien organizó la reunión (DC43).
 */
export type AreaAcuerdo = AreaParticipante | 'supplier';
export const AREAS_ACUERDO: readonly AreaAcuerdo[] = ['compras', 'marketing', 'finanzas', 'direccion', 'supplier'];

export const ETIQUETA_AREA_ACUERDO: Readonly<Record<AreaAcuerdo, string>> = {
  compras: 'Compras',
  marketing: 'Mercadotecnia',
  finanzas: 'Finanzas',
  direccion: 'Dirección',
  supplier: 'Proveedor',
};

/**
 * El estado de un acuerdo, en el canónico del contrato de tareas. `not_applicable` no entra: un acuerdo que ya no
 * procede se CANCELA, con nota.
 *  - `pending`: pendiente.
 *  - `in_progress`: en curso.
 *  - `done`: cumplido. ⛔ Exige nota de cierre.
 *  - `cancelled`: cancelado. ⛔ Exige nota de cierre.
 */
export type EstadoAcuerdo = Extract<EstadoTarea, 'pending' | 'in_progress' | 'done' | 'cancelled'>;
export const ESTADOS_ACUERDO: readonly EstadoAcuerdo[] = ['pending', 'in_progress', 'done', 'cancelled'];

export const ETIQUETA_ESTADO_ACUERDO: Readonly<Record<EstadoAcuerdo, string>> = {
  pending: 'Pendiente',
  in_progress: 'En curso',
  done: 'Cumplido',
  cancelled: 'Cancelado',
};

/** Los estados que se cierran con nota (y dejan quién y cuándo). */
export const ESTADOS_ACUERDO_CERRADOS: readonly EstadoAcuerdo[] = ['done', 'cancelled'];

/** Qué se acordó: una línea larga. El CHECK de la tabla tiene el mismo tope. */
export const MAX_DESCRIPCION_ACUERDO = 500;
/** El nombre de la persona del proveedor (sólo en los acuerdos del proveedor). El CHECK tiene el mismo tope. */
export const MAX_CONTACTO_PROVEEDOR = 120;
/** La nota con que se cierra (cumplido o cancelado). */
export const MAX_NOTA_CIERRE_ACUERDO = 500;
/** La fecha compromiso, a lo más dos años después de la reunión: más lejos parece un error de captura. */
export const DIAS_MAX_COMPROMISO = 730;

/**
 * Cómo va un acuerdo, para la persona. Derivado del estado y de la fecha compromiso contra HOY (Ciudad de México):
 * no se guarda. El orden de esta lista es el de la pestaña: lo vencido primero.
 */
export type SituacionAcuerdo = 'vencido' | 'vence_hoy' | 'esta_semana' | 'al_dia' | 'cumplido' | 'cancelado';
export const SITUACIONES_ACUERDO: readonly SituacionAcuerdo[] = ['vencido', 'vence_hoy', 'esta_semana', 'al_dia', 'cumplido', 'cancelado'];

export const ETIQUETA_SITUACION_ACUERDO: Readonly<Record<SituacionAcuerdo, string>> = {
  vencido: 'Vencido',
  vence_hoy: 'Vence hoy',
  esta_semana: 'Esta semana',
  al_dia: 'Al día',
  cumplido: 'Cumplido',
  cancelado: 'Cancelado',
};

/** Lo que se puede hacer con un acuerdo. Cumplir y cancelar exigen nota; un acuerdo cerrado no se reabre. */
export type AccionAcuerdo = 'iniciar' | 'cumplir' | 'cancelar' | 'editar';
export const ACCIONES_ACUERDO: readonly AccionAcuerdo[] = ['iniciar', 'cumplir', 'cancelar', 'editar'];

/**
 * Capturar o editar un acuerdo. `assigned_to` sólo en las áreas de Mega Dulces: en el del proveedor el responsable es
 * quien organizó la reunión (DC43) y lo pone el servidor.
 */
export interface CapturarAcuerdoDto {
  area: AreaAcuerdo;
  description: string;
  due_date: string;
  assigned_to?: string | null;
  supplier_contact?: string | null;
}

/** Cerrar un acuerdo (cumplirlo o cancelarlo): siempre con nota. */
export interface CerrarAcuerdoDto {
  note: string;
}

// ── La API de Acuerdos (`[PQ.3.10]` C2) ───────────────────────────────────────────────────────────────────────────

/** Cuántos acuerdos trae cada lista (con el total siempre: una lista topada lo declara). */
export const LIMITES_ACUERDOS = {
  /** Los abiertos de la pestaña. */
  abiertos: 500,
  /** Los cerrados de la pestaña: los más recientes. */
  cerrados: 100,
  /** Los abiertos del mismo proveedor que se ven al abrir una reunión. */
  del_proveedor: 50,
} as const;

/** Las situaciones de un acuerdo abierto (las que cuenta la pestaña). */
export type SituacionAbierta = Exclude<SituacionAcuerdo, 'cumplido' | 'cancelado'>;

/** Un acuerdo como lo ve la persona: con su reunión de origen, sus nombres y lo que se le puede hacer. */
export interface AcuerdoVista {
  readonly id: string;
  readonly meeting_id: string;
  /** El proveedor se deriva de la reunión (no se copia, ADR-056). */
  readonly supplier_code: string;
  readonly supplier_name: string | null;
  /** El día de la reunión de origen (Ciudad de México). */
  readonly meeting_date: string;
  readonly area: AreaAcuerdo;
  readonly description: string;
  readonly supplier_contact: string | null;
  readonly assigned_to: { readonly user_id: string; readonly nombre: string };
  readonly due_date: string;
  readonly status: EstadoAcuerdo;
  readonly situacion: SituacionAcuerdo;
  /** Derivadas del estado con la misma regla que frena la escritura (la pantalla además exige la llave de agendar). */
  readonly acciones: readonly AccionAcuerdo[];
  /** Nombre de quien lo cerró, cuándo y con qué nota (sólo cumplido o cancelado). */
  readonly closed_by: string | null;
  readonly closed_at: string | null;
  readonly closing_note: string | null;
  /** Nombre de quien lo asignó por última vez y cuándo (cambiar el responsable lo renueva). */
  readonly assigned_by: string | null;
  readonly assigned_at: string;
}

/** `GET /compras/proveedores/acuerdos` — la pestaña: los abiertos (lo vencido primero) y los últimos cerrados. */
export interface ListaAcuerdos {
  readonly hoy: string;
  readonly abiertos: {
    readonly total: number;
    readonly tope: number;
    readonly por_situacion: Readonly<Record<SituacionAbierta, number>>;
    readonly acuerdos: readonly AcuerdoVista[];
  };
  readonly cerrados: { readonly total: number; readonly tope: number; readonly acuerdos: readonly AcuerdoVista[] };
}

/**
 * `GET /compras/proveedores/acuerdos/reunion/:meetingId` — los acuerdos de una reunión, si puede recibir más (y por qué
 * no), y lo que sigue abierto con el MISMO proveedor de otras reuniones (con eso abre la reunión siguiente).
 */
export interface AcuerdosDeReunion {
  readonly hoy: string;
  readonly meeting_id: string;
  /** El día de la reunión: la fecha compromiso no puede ser antes. */
  readonly meeting_date: string;
  /** `null` si la reunión recibe acuerdos; si no, el porqué (la misma regla que frena la escritura). */
  readonly no_recibe: string | null;
  /** Quien organizó la reunión: el responsable de los acuerdos del proveedor (DC43). */
  readonly organizer: { readonly user_id: string; readonly nombre: string };
  readonly acuerdos: readonly AcuerdoVista[];
  readonly del_proveedor: { readonly total: number; readonly tope: number; readonly acuerdos: readonly AcuerdoVista[] };
}

/** Lo que regresa capturar, editar, iniciar, cumplir o cancelar. */
export interface AcuerdoGuardado {
  readonly id: string;
}
