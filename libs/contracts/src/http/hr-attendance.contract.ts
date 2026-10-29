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

/**
 * `GET /hr/attendance/people` — `[RH.1.7c]` el directorio de todas las plazas, para buscar a alguien sin saber dónde
 * checa. Un renglón por código de cada sitio; los códigos sin ligar a una persona traen el nombre del reloj.
 */
export interface HrPersonaDirectorioDto {
  site_code: string;
  site_name: string;
  codigo: string;
  nombre: string;
  departamento: string | null;
  /** Ligado a una persona de la Suite. */
  ligado: boolean;
  /** De promotoría de marca: se ve en la vista de Promotoras, no en la de planta. */
  promotora: boolean;
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
  // ── `[RH.1.10]` Horas extra y ajustes del día (Mega Talento ee4ff38) ──
  /** A qué hora debía salir ese día (su referencia de entrada + su jornada). */
  salidaEsperada?: string | null;
  /** Horas extra GANADAS ese día, en bloques de 30 min. */
  extraMin?: number;
  /** «Desayuno distinto» / «Comida distinta»: los minutos que RH autorizó ese día. */
  desayunoPermitidoMin?: number;
  comidaPermitidaMin?: number;
  /** «Cambio de día de descanso»: este día pasó a ser su descanso, o a ser de trabajo. */
  descansoCambio?: 'descansa' | 'trabaja';
  /** `[RH.1.15]` Con varios horarios asignados: la entrada del que trabajó ese día (contra cuál se midió). */
  turno?: string;
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

/** `[RH.1.15]` Uno de los horarios (turnos) que RH le asignó a una persona. */
export interface HrTurnoAsignado {
  entrada: string;
  salida: string;
  comidaMin: number;
}

/**
 * El horario completo que RH le asignó a una persona. `[RH.1.15]` Puede tener hasta 4 (`horarios`;
 * con uno solo, ése uno) y `entrada`/`salida`/`comidaMin` son los del primero. Cada día se mide
 * contra el más cercano a su entrada. El sábado es uno solo para todos.
 */
export interface HrHorarioAsignado extends HrTurnoAsignado {
  horarios: HrTurnoAsignado[];
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
  /** `[RH.1.10]` Horas extra ganadas en el periodo (bloques de 30 min después de su salida). */
  horasExtraGanadasMin: number;
  /** Horas extra que usó en el periodo («Uso de horas extra»). */
  horasExtraUsadasMin: number;
  /** Contra qué salida se midieron: la de su horario asignado, la deducida, o null si no se le calculan. */
  horasExtraSegun: 'asignado' | 'deducido' | null;
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
  /** `[RH.1.15]` De 2 a 4 horarios (mañana, tarde…); con él, `starts_at`/`ends_at`/`lunch_minutes` son los del primero. */
  shifts?: Array<{ starts_at: string; ends_at: string; lunch_minutes: number }>;
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
  summary: {
    personas: number; usables: number; faltas: number; retardoRealMin: number; horasTrabajadas: number; incidencias: number;
    /** `[RH.1.6b]` Sólo si se cerró con gente sin identificar: cuántos, quiénes y el motivo que se escribió. */
    sinIdentificar?: number; motivoSinIdentificar?: string; codigosSinIdentificar?: string[];
  } | null;
  reopened_by: string | null;
  reopened_by_name: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  vigente: boolean;
  /** Sólo en `GET /closures/:id`: la foto de la semana tal como se cerró. */
  snapshot?: HrAsistenciaResponse;
}

// ── `[RH.1.10]` Banco de horas extra ───────────────────────────────────────────────────────

/** Un día en que ganó horas extra. */
export interface HrDiaHorasExtraDto {
  fecha: string;
  entrada: string | null;
  salida: string | null;
  /** A qué hora debía salir ese día. */
  salidaEsperada: string | null;
  extraMin: number;
}

/** Un «Uso de horas extra» dentro del banco. */
export interface HrUsoHorasExtraDto {
  id: string;
  desde: string;
  hasta: string;
  /** Minutos por día. */
  minutos: number;
  /** Días dentro del banco (desde que arranca hasta la fecha pedida). */
  dias: number;
  totalMin: number;
  nota: string;
}

/** Un ajuste de RH al banco: saldo inicial o corrección, con signo. */
export interface HrAjusteHorasExtraDto {
  id: string;
  fecha: string;
  /** Con signo: +330 suma 5 h 30 min; −60 resta 1 h. */
  minutos: number;
  motivo: string;
  creadoPor: string;
  creadoEn: string;
}

export interface HrPersonaHorasExtraDto {
  codigo: string;
  nombreCompleto: string;
  departamento: string | null;
  /** Contra qué salida se midió: su horario asignado o el deducido. */
  segun: 'asignado' | 'deducido' | null;
  salida: string | null;
  ganadasMin: number;
  usadasMin: number;
  ajustesMin: number;
  saldoMin: number;
  ganadas: HrDiaHorasExtraDto[];
  usos: HrUsoHorasExtraDto[];
  ajustes: HrAjusteHorasExtraDto[];
}

/** `GET /hr/attendance/overtime` — el banco de horas extra de un sitio (o de una persona). */
export interface HrBancoHorasExtraDto {
  sucursalId: string;
  desde: string;
  hasta: string;
  bloqueMin: number;
  /** Personas de planta a las que NO se les calculan (medio tiempo, rotativo o sin horario). */
  sinHorarioFijo: number;
  personas: HrPersonaHorasExtraDto[];
}

/** `POST /hr/attendance/overtime/adjustments`. */
export interface HrAjusteHorasExtraBody {
  site_code: string;
  person_code: string;
  /** Con signo, distinto de cero. */
  minutes: number;
  reason: string;
  /** yyyy-MM-dd; hoy si no viene. */
  effective_date?: string;
}

/**
 * `[RH.1.6b]` Quien checó en la semana y no está identificado. Viene en el cuerpo del 409 de
 * `POST /closures` (`{ message, sinIdentificar }`); con `force: true` + `reason` se cierra igual.
 */
export interface HrSinIdentificarDto {
  codigo: string;
  nombre: string;
  checadas: number;
  sinFicha: boolean;
  sinNombre: boolean;
  sinDepartamento: boolean;
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

// ── `[RH.1.12]` Códigos sin persona: la bandeja para ligarlos ───────────────────────────────────────────────

/** Por qué la Suite propone a esa persona (el mismo motor de la carga de personas). */
export type HrMotivoCandidato = 'mismo_codigo' | 'mismo_nombre' | 'nombre_parecido';

export interface HrCandidatoPersonaDto {
  user_id: string;
  nombre: string;
  status: string | null;
  motivo: HrMotivoCandidato;
  /** Lo que el motor elegiría solo. RH confirma igual: nunca se liga automático. */
  sugerido: boolean;
}

/** Un código que checa y no está ligado a ninguna persona: sin persona no genera faltas ni entra al reporte. */
export interface HrSinPersonaDto {
  enrollment_id: string;
  site_code: string;
  site_name: string;
  device_label: string | null;
  serial_number: string;
  codigo: string;
  nombre_reloj: string | null;
  ultima_checada: string | null;
  checadas_14d: number;
  /** La ficha de esa plaza, si ya existe (sección del reporte y casilla de promotora). */
  seccion: string | null;
  promotora: boolean;
  candidatos: HrCandidatoPersonaDto[];
}

/** `GET /hr/attendance/enrollments/unlinked`. `secciones`: las que ya existen, para elegir al dar de alta. */
export interface HrSinPersonaResponse {
  filas: HrSinPersonaDto[];
  total: number;
  secciones: string[];
}

/** Ligar un código a una persona que ya existe. `reemplazar`: si ya estaba ligado a OTRA persona (se exige decirlo). */
export interface HrLigarBody {
  user_id: string;
  reemplazar?: boolean;
}

export interface HrDesligarBody {
  motivo: string;
}

/** Dar de alta a la persona (sin contraseña ni acceso) y ligarle el código. */
export interface HrAltaPersonaBody {
  nombre: string;
  seccion: string;
  promotora?: boolean;
}

export interface HrLigarResultadoDto {
  user_id: string;
  nombre: string;
  /** Cuántos enrolamientos quedaron ligados (el mismo código en los relojes de la plaza). */
  enrolamientos: number;
}

/** `GET /hr/attendance/enrollments/people?q=` — buscar a mano a quién ligar. */
export interface HrPersonaBuscadaDto {
  user_id: string;
  nombre: string;
  status: string | null;
  warehouse_code: string | null;
}
