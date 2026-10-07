/**
 * Fase RH (ADR-084) · `[RH.1.7]` — el contrato HTTP de asistencia, incidencias, cierres y relojes.
 *
 * El productor (`libs/hr`) y el consumidor (`apps/view`, pantallas `/rh/*`) importan de acá: un tipo
 * escrito dos veces a mano deriva (la lección del tipo de procedencia, copiado al frontend a los tres
 * días). **Sólo tipos y constantes pequeñas**: este barril lo cargan las apps Angular al arrancar.
 *
 * La asistencia por persona conserva las claves en español de Mega Talento (ADR-084, opción rápida:
 * se trasladó la lógica, no se reescribió). Lo que es fila de una tabla nueva (incidencias, cierres,
 * relojes) sale con sus columnas en inglés.
 *
 * ⚠️ Sin `generated_at`: son datos transaccionales vivos (`check:provenance`).
 */

// ── Sitios de checado ─────────────────────────────────────────────────────────────────────

/** Un sitio de checado: los relojes que comparten la numeración de personas. No es un almacén. */
export interface HrSiteDto {
  code: string;
  name: string;
  warehouse_code: string | null;
  is_active: boolean;
}

// ── Asistencia por persona ───────────────────────────────────────────────────────────────

export const HR_ESTADOS_DIA = ['a_tiempo', 'absorbido', 'retardo', 'falta', 'descanso', 'marca_faltante', 'justificado'] as const;
export type HrEstadoDia = (typeof HR_ESTADOS_DIA)[number];

export type HrTipoHorario = 'fijo' | 'rotativo' | 'sin_patron' | 'sin_datos';
export type HrGravedad = 'alta' | 'media' | 'info' | 'ok';

/** Por qué el número de una persona puede no ser de fiar (`usable = false` si hay alguna `alta`). */
export interface HrMarcaAsistencia {
  codigo: string;
  gravedad: HrGravedad;
  detalle: string;
  opciones?: (string | null)[];
  impacto?: Array<{ turno: string; retardoRealMin: number | null; diasConRetardo: number | null }>;
  turnoActual?: string | null;
  turnosActuales?: (string | null)[];
}

/** Una incidencia tal como se pinta en la celda del día. */
export interface HrIncidenciaDelDia {
  id: string;
  tipo: string;
  codigo: string;
  etiqueta: string;
  nota: string;
  minutos?: number | null;
}

/** Un día medido, con su comida y sus horas. */
export interface HrDiaAsistencia {
  fecha: string;
  estado: HrEstadoDia;
  entrada?: string | null;
  salida?: string | null;
  /** La marca única, cuando el día es `marca_faltante`. */
  hora?: string | null;
  /** Contra qué hora se midió. */
  referencia?: string | null;
  atrasoMin: number;
  absorbidoMin: number;
  retardoRealMin: number;
  bolsaAntes: number;
  bolsaDespues: number;
  atipico?: boolean;
  marcas?: number;
  descansoPorAusencia?: boolean;
  horarioDistinto?: boolean;
  comida: string;
  horasNetas: string;
  justificacion?: string;
  desayunoMin?: number | null;
  desayunoExcesoMin?: number | null;
  netasMin?: number | null;
  desayunoPagado?: boolean;
  horasExtraUsadasMin?: number;
  incidencias?: HrIncidenciaDelDia[];
  comidaMin?: number | null;
  comidaExcesoMin?: number | null;
  salidaAntesMin?: number | null;
  esperadoMin?: number | null;
}

/** Una semana de nómina (jueves a miércoles) con su bolsa de tolerancia. */
export interface HrSemanaAsistencia {
  inicio: string;
  bolsaInicial: number;
  bolsaRestante: number;
  atrasoMin: number;
  retardoRealMin: number;
  bolsaAgotada: boolean;
  dias: HrDiaAsistencia[];
  minutosTrabajados: number;
}

/** El horario completo que RH le asignó a una persona. */
export interface HrHorarioAsignado {
  entrada: string;
  salida: string;
  comidaMin: number;
  sabado: boolean;
  sabadoEntrada: string | null;
  sabadoSalida: string | null;
  asignadoPor: string | null;
  actualizadoEn: string | null;
}

export interface HrPersonaAsistencia {
  codigo: string;
  userId: string | null;
  nombre: string;
  nombreCompleto: string;
  departamento: string | null;
  esPracticante: boolean;
  puesto: string;
  fotoUrl: string;
  /** Ligada a una persona de la Suite. */
  registrado: boolean;
  activo: boolean | null;
  tipo: HrTipoHorario;
  horario: string | null;
  turnos: (string | null)[];
  horarioConfirmado: boolean;
  costumbre: string | null;
  desfaseMin: number | null;
  salida: string | null;
  dispersionMin: number | null;
  diasLaborales: number[];
  diasUsados: number;
  diasEnRango: number;
  silencioDias: number | null;
  pctUnaMarca: number;
  retardoRealMin: number;
  atrasoBrutoMin: number;
  absorbidoMin: number;
  diasConRetardo: number;
  diasEvaluados: number;
  faltas: number;
  faltasJustificadas: number;
  diasNoMedibles: number;
  diasAtipicos: number;
  horasTrabajadas: number;
  minutosTrabajados: number;
  diasConIncidencia: number;
  incidencias: Array<HrIncidenciaDelDia & { desde: string; hasta: string }>;
  desayunoExcesoMin: number;
  diasDesayunoExcedido: number;
  /** Sobre los días que sí se pudieron evaluar; null = no hay respuesta (no es 0%). */
  pctATiempo: number | null;
  semanas: HrSemanaAsistencia[];
  marcas: HrMarcaAsistencia[];
  usable: boolean;
  bloqueadoPor: string[];
  horarioAsignado: HrHorarioAsignado | null;
  minutosEsperados: number | null;
}

/** `GET /hr/attendance/report` — la asistencia de un sitio en un rango. */
export interface HrAsistenciaResponse {
  sucursalId: string;
  desde: string;
  hasta: string;
  desdeHorario: string;
  ventanaHorarioDias: number;
  bolsaSemanalMin: number;
  corteSemana: string;
  diaInicioSemana: number;
  diasExTrabajador: number;
  desayunoAlertaMin: number;
  mideRetardo: boolean;
  resumen: {
    personas: number;
    usables: number;
    conPendiente: number;
    fijos: number;
    rotativos: number;
    sinPatron: number;
    sinDatos: number;
    horarioAmbiguo: number;
    horarioConfirmado: number;
    soloUnaMarca: number;
    exTrabajadores: number;
    fueraDelPadron: number;
    retardoRealMin: number;
    retardoRealUsableMin: number;
    atrasoBrutoMin: number;
    absorbidoMin: number;
    faltas: number;
    faltasJustificadas: number;
    diasNoMedibles: number;
    horasTrabajadas: number;
    desayunoExcesoMin: number;
    diasDesayunoExcedido: number;
  };
  personas: HrPersonaAsistencia[];
}

/** `PUT /hr/attendance/person-schedules` — ponerle su horario a una o varias personas. */
export interface HrHorarioPersonaBody {
  site_code: string;
  person_codes: string[];
  starts_at: string;
  ends_at: string;
  lunch_minutes: number;
  works_saturday?: boolean;
  saturday_starts_at?: string;
  saturday_ends_at?: string;
}

// ── Incidencias ─────────────────────────────────────────────────────────────────────────

export const HR_ESTADOS_INCIDENCIA = ['capturada', 'calificada', 'rechazada', 'cerrada', 'auditada', 'anulada'] as const;
export type HrEstadoIncidencia = (typeof HR_ESTADOS_INCIDENCIA)[number];
export type HrAccionIncidencia = 'calificar' | 'rechazar' | 'anular' | 'auditar';
export type HrBanderaIncidencia = 'corrimiento_60' | 'hd_frecuente' | 'autocalificada' | 'sin_nota' | 'retroactiva';

export interface HrTipoIncidenciaDto {
  tipo: string;
  etiqueta: string;
  codigo: string;
  excusaFalta: boolean;
}

/** Una incidencia (fila de `hr.attendance_incidents`), con las banderas que ve la auditoría. */
export interface HrIncidenciaDto {
  id: string;
  site_code: string;
  person_code: string;
  incident_type: string;
  date_from: string;
  date_to: string;
  minutes: number | null;
  note: string | null;
  status: HrEstadoIncidencia;
  authorized_by_name: string | null;
  base_schedule_minutes: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  rated_by: string | null;
  rated_by_name: string | null;
  rated_at: string | null;
  rejection_reason: string | null;
  audited_by: string | null;
  audited_by_name: string | null;
  audited_at: string | null;
  audit_note: string | null;
  voided_by: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
  hd_30d?: number | null;
  banderas?: HrBanderaIncidencia[];
}

/** `POST /hr/attendance/incidents`. */
export interface HrCapturaIncidenciaBody {
  site_code: string;
  person_code: string;
  incident_type: string;
  date_from: string;
  date_to?: string;
  note?: string;
  minutes?: number;
  /** Horario distinto: por qué ese día entró a otra hora. */
  reason?: string;
  authorized_by_name?: string;
  base_schedule_minutes?: number;
  /** Quien califica captura ya calificada, salvo que la entregue a propósito para otra persona. */
  deliver?: boolean;
}

export interface HrPasoIncidenciaDto {
  action: string;
  status_before: string | null;
  status_after: string | null;
  actor_id: string | null;
  actor_name: string | null;
  acted_at: string;
  detail: string | null;
}

// ── Cierre de semana ────────────────────────────────────────────────────────────────────

export interface HrCierreDto {
  id: string;
  site_code: string;
  period_start: string;
  period_end: string;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: string;
  summary: { personas: number; usables: number; faltas: number; retardoRealMin: number; horasTrabajadas: number; incidencias: number } | null;
  reopened_by: string | null;
  reopened_by_name: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  vigente: boolean;
  /** Sólo en `GET /closures/:id`: la foto de la semana tal como se cerró. */
  snapshot?: HrAsistenciaResponse;
}

// ── Relojes ─────────────────────────────────────────────────────────────────────────────

export type HrSemaforoReloj = 'ok' | 'atrasado' | 'mudo' | 'pendiente';

/** `GET /hr/attendance/devices`. */
export interface HrRelojDto {
  id: string;
  serial_number: string;
  site_code: string | null;
  site_name: string | null;
  label: string | null;
  ip_address: string | null;
  port: number;
  ingest_mode: 'agente' | 'push' | 'manual';
  comm_key: number;
  is_active: boolean;
  is_paused: boolean;
  notes: string | null;
  model: string | null;
  firmware: string | null;
}

/** `GET /hr/attendance/devices/status` — el semáforo (claves de Mega Talento). */
export interface HrRelojEstadoDto {
  serie: string;
  sucursalId: string | null;
  alias: string;
  modo: string;
  ip: string;
  nota: string;
  ultimaSenal: string | null;
  ultimaChecada: string | null;
  ultimoBackfill: string | null;
  segundosSinSenal: number | null;
  logsEnReloj: number | null;
  logsEnBase: number | null;
  desfaseRelojSeg: number | null;
  ultimoError: string;
  agenteVersion: string;
  agenteHost: string;
  semaforo: HrSemaforoReloj;
}

/** `PUT /hr/attendance/devices/:serial`. */
export interface HrRelojBody {
  site_code: string;
  label?: string | null;
  ip_address?: string | null;
  port?: number;
  ingest_mode?: 'agente' | 'push' | 'manual';
  comm_key?: number;
  is_active?: boolean;
  is_paused?: boolean;
  notes?: string | null;
}

/** `GET /hr/attendance/devices/pending-batches`. */
export interface HrLotePendienteDto {
  serial_number: string;
  source: string;
  status: 'sin_registrar' | 'en_pausa';
  error: string | null;
  lotes: number;
  registros: number;
  primero: string;
  ultimo: string;
}

export type HrOrdenReloj = 'borrar' | 'renombrar' | 'restaurar';
export type HrEstadoOrden = 'pendiente' | 'enviado' | 'hecho' | 'error' | 'cancelado';

export interface HrOrdenDto {
  id: string;
  command: HrOrdenReloj;
  payload: Record<string, unknown> | null;
  status: HrEstadoOrden;
  attempts: number;
  detail: string | null;
  requested_at: string;
  completed_at: string | null;
  device_user_id: string;
  serial_number: string;
  label: string | null;
  person_code: string;
  con_respaldo: boolean;
}

/** `GET /hr/attendance/devices/commands`. */
export interface HrOrdenesResponse {
  relojes: Array<{ id: string; serial_number: string; label: string | null }>;
  ordenes: HrOrdenDto[];
}
