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

/**
 * `[RH.15.2]` `sin_dato`: un día laborable sin checadas de NADIE de la plaza. No se distingue un reloj caído de una
 * falta, así que no se cuenta como falta (LFT 805: un registro que inventa faltas pierde valor como prueba).
 */
export const HR_ESTADOS_DIA = ['a_tiempo', 'absorbido', 'retardo', 'falta', 'descanso', 'marca_faltante', 'justificado', 'sin_dato'] as const;
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
  /** `[RH.6.3]` Con varios horarios asignados: la entrada del que trabajó ese día. */
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
  /**
   * `[RH.15.10]` La semana contra la LEY (LFT 59/66/68 y transitorios del DOF 1-may-2026), no contra su horario:
   * jornada máxima del año, tope de horas extra, cuánto se pasó y cuánto de eso se paga al triple. Opcional: una API
   * anterior no lo manda.
   */
  legal?: { anio: number; jornadaMaxMin: number; extraMaxMin: number; excedenteMin: number; triplesMin: number };
}

/** Un horario de lunes a viernes: entrada, salida y comida. */
export interface HrTurnoAsignado {
  entrada: string;
  salida: string;
  comidaMin: number;
}

/**
 * El horario completo que RH le asignó a una persona. `[RH.6.3]` Puede tener hasta 4 (mañana,
 * tarde…): `horarios` los trae todos (con uno solo, ese uno) y `entrada`/`salida`/`comidaMin` son los
 * del primero. Cada día se mide contra el más cercano a su entrada; el sábado es uno solo.
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
  /** `[RH.15.2]` Días laborables sin checadas de nadie de la plaza: no cuentan como falta. Opcional: una API anterior no lo manda. */
  diasSinDato?: number;
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
    /** `[RH.15.2]` Ver `diasSinDato` de la persona. */
    diasSinDato?: number;
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
  /** `[RH.6.3]` Con 2-4 horarios (mañana, tarde…): todos aquí; `starts_at`/`ends_at`/`lunch_minutes` son los del primero. */
  shifts?: Array<{ starts_at: string; ends_at: string; lunch_minutes: number }>;
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
  /** `[RH.17.2]` Horario distinto: salida de ese día (minuto del día) y su comida en minutos. Null = no se capturó. */
  end_minutes?: number | null;
  break_minutes?: number | null;
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
  /**
   * `[RH.13.2]` El nombre de la persona en esa plaza (el de la Suite o, sin ligar, el del reloj). Null si no hay
   * ninguno: se muestra el número, no se inventa. Opcional: una API anterior no lo manda.
   */
  person_name?: string | null;
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
  /** `[RH.17.2]` Horario distinto: salida de ese día (minuto del día) y comida (minutos), opcionales. */
  end_minutes?: number | null;
  break_minutes?: number | null;
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

/** `[RH.6.7]` Un pago de horas extras: el TOTAL pagado en una fecha, con su referencia. */
export interface HrPagoHorasExtraDto {
  id: string;
  fecha: string;
  minutos: number;
  nota: string;
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
  /** `[RH.6.7]` Lo que ya se le pagó en efectivo: descuenta del saldo. Opcional: una API anterior no lo manda. */
  pagadasMin?: number;
  ajustesMin: number;
  saldoMin: number;
  ganadas: HrDiaHorasExtraDto[];
  usos: HrUsoHorasExtraDto[];
  ajustes: HrAjusteHorasExtraDto[];
  /** `[RH.6.7]` Cada «Pago de horas extras» del banco. */
  pagos?: HrPagoHorasExtraDto[];
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

// ── `[RH.7.4]` Cruces de plaza: la misma persona checando en dos sedes el mismo día ─────────────

/**
 * Cómo se lee un día con estancias en dos sedes (Mega Talento `cruces-plazas.ts`):
 * `traslape` = dos jornadas que se pisan (nadie está en dos plazas a la vez) · `marca_ajena` = una marca suelta en la
 * plaza ajena a media jornada propia · `jornada_partida` = cubrió dos tiendas, su día quedó cortado · `sueltas` = dos
 * presencias sin relación · `ruta_promotora` = la ruta de una promotora (normal).
 */
export type HrClaseCruce = 'traslape' | 'marca_ajena' | 'jornada_partida' | 'sueltas' | 'ruta_promotora';

export interface HrEstanciaCruce {
  site_code: string;
  codigo: string;
  /** 'HH:mm' */
  primera: string;
  ultima: string;
  marcas: number;
}

export interface HrDiaCruce {
  fecha: string;
  estancias: HrEstanciaCruce[];
  clase: HrClaseCruce;
  /** Minutos entre el fin de una estancia y el inicio de la siguiente. Negativo = se enciman. */
  huecoMin: number | null;
}

export interface HrPersonaCruce {
  user_id: string;
  nombre: string;
  esPromotora: boolean;
  /** Dónde está enrolada (plaza + su código en cada una). */
  altas: Array<{ site_code: string; codigo: string }>;
  /** Su clase más grave en el periodo: es lo que ordena la lista. */
  clase: HrClaseCruce;
  dias: HrDiaCruce[];
  diasCruzados: number;
  traslapes: number;
  marcasAjenas: number;
  ultimoDia: string;
}

/** `GET /hr/attendance/crossings?date_from&date_to` — todas las plazas a la vez (el cruce sólo existe entre plazas). */
export interface HrCrucesDto {
  desde: string;
  hasta: string;
  /** Personas enroladas en dos sedes o más (con o sin cruce de marcas en el periodo). */
  enDosSedes: number;
  personas: HrPersonaCruce[];
  resumen: { personas: number; dias: number; traslapes: number; marcasAjenas: number; jornadasPartidas: number; rutas: number };
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
  /**
   * `[RH.13.1]` La última LECTURA buena del reloj (`last_sync_at`) y su edad. Con `ultimoError`, es lo que cuenta: el
   * lector sigue mandando latidos aunque no alcance al equipo. Opcionales: una API anterior no los manda.
   */
  ultimaLectura?: string | null;
  segundosSinLectura?: number | null;
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

/**
 * `[RH.7.1]` `PUT /hr/attendance/enrollments/site-profile` — corregir la ficha de una persona EN UNA PLAZA: su sección del
 * reporte de RH, si es promotora y su nombre completo (`[RH.14.4]`: a cualquiera, tenga o no acceso). Lo que no viene, no
 * cambia.
 */
export interface HrFichaPlazaBody {
  site_code: string;
  person_code: string;
  nombre?: string;
  seccion?: string;
  promotora?: boolean;
  /**
   * `[RH.14.5]` De la PERSONA, no de la plaza, y sólo si no tiene acceso a la Suite (Edgar, D2 del 18-nov): a quien tiene
   * acceso lo cambia Sistemas, porque su sucursal y su zona definen lo que ve. `null` = quitarlo. La zona no se elige:
   * sale de la sucursal.
   */
  departamento_code?: string | null;
  puesto_code?: string | null;
  sucursal_code?: string | null;
}

export interface HrFichaPlazaDto {
  site_code: string;
  person_code: string;
  seccion: string | null;
  promotora: boolean;
  /** El nombre de la persona ligada (null si el código no tiene persona). */
  nombre: string | null;
}

/** `[RH.7.2]` Dar de baja o reactivar a una persona EN UNA PLAZA (la baja exige motivo). */
export interface HrBajaPlazaBody {
  site_code: string;
  person_code: string;
  motivo?: string;
}

/** `[RH.7.2]` `GET /hr/attendance/enrollments/site-profiles/inactive` — la papelera de una plaza. */
export interface HrBajaPlazaDto {
  person_code: string;
  user_id: string | null;
  nombre: string | null;
  seccion: string | null;
  promotora: boolean;
  /** Cuándo se dio de baja: el asiento de la Suite, o la última edición de la ficha si vino así de Mega Talento. */
  desde: string | null;
  motivo: string | null;
  por: string | null;
  /** 'suite' = la dio alguien aquí (con su asiento); 'mega_talento' = llegó de baja en la carga. */
  origen: 'suite' | 'mega_talento';
  ultima_checada: string | null;
  /** Checadas en esta plaza DESPUÉS de la baja: si es > 0, sigue checando (¿la baja fue un error?). */
  checadas_desde_baja: number;
}

/**
 * `[RH.14.1]` Después de una baja: la persona ya no tiene NINGUNA plaza activa. Si `archivable` (no tiene acceso a la
 * Suite), la pantalla propone archivarla también como persona (Edgar, D3 del 18-nov); si tiene acceso, lo hace Sistemas.
 */
export interface HrSinPlazasDto {
  user_id: string;
  nombre: string | null;
  archivable: boolean;
}

/** `POST /hr/attendance/enrollments/site-profile/deactivate`. */
export interface HrBajaResultadoDto {
  ok: true;
  /** Presente sólo si con esta baja la persona se quedó sin plazas activas. */
  sin_plazas?: HrSinPlazasDto;
}

/** `[RH.14.6]` `POST /hr/attendance/enrollments/site-profile/deactivate-batch` — varias bajas en una plaza, con un motivo. */
export interface HrBajaLoteBody {
  site_code: string;
  person_codes: string[];
  motivo: string;
}

/** Cada baja es independiente: las que fallan no deshacen las demás, y se dicen por código. */
export interface HrBajaLoteResultadoDto {
  dados_de_baja: string[];
  fallaron: Array<{ person_code: string; error: string }>;
  sin_plazas: HrSinPlazasDto[];
}

/** `[RH.14.1]` `POST /hr/attendance/enrollments/person/archive` — archivar a la persona (sin acceso y sin plazas activas). */
export interface HrArchivarPersonaBody {
  user_id: string;
  motivo: string;
}

/** `[RH.14.6]` `GET /hr/attendance/enrollments/site-profiles/stale?site_code=&days=` — quién lleva N días sin checar. */
export interface HrPosibleBajaDto {
  person_code: string;
  user_id: string;
  nombre: string | null;
  seccion: string | null;
  promotora: boolean;
  ultima_checada: string | null;
  /** null = nunca checó en esta plaza (no se sabe desde cuándo). */
  dias_sin_checar: number | null;
  /** En cuántas OTRAS plazas sigue activa: si es 0, con la baja se queda sin ninguna. */
  otras_plazas_activas: number;
}

export interface HrPosiblesBajasResponse {
  site_code: string;
  dias: number;
  filas: HrPosibleBajaDto[];
  /** No se proponen: una incidencia que justifica la ausencia toca el tramo sin checar. */
  explicadas: Array<HrPosibleBajaDto & { incidencia: { etiqueta: string; desde: string; hasta: string } }>;
}

/**
 * `[RH.14.3]` `GET /hr/attendance/enrollments/site-profile?site_code=&person_code=` — la ficha completa de una persona en
 * una plaza: cómo está en cada reloj, su ficha de la plaza y lo que es de la persona (departamento, puesto, sucursal).
 */
export interface HrFichaPersonaDto {
  site_code: string;
  person_code: string;
  user_id: string | null;
  nombre: string | null;
  /** Tiene un rol distinto de `sin_acceso`: su departamento, puesto y sucursal los cambia Sistemas (el nombre, RH). */
  con_acceso: boolean;
  /** `terminated` = archivada. */
  status: string | null;
  activa_en_plaza: boolean;
  seccion: string | null;
  promotora: boolean;
  departamento_code: string | null;
  puesto_code: string | null;
  sucursal_code: string | null;
  zona_nombre: string | null;
  relojes: Array<{ device_label: string | null; serial_number: string; device_user_id: string; nombre_reloj: string | null }>;
  /** Cómo quedaría su nombre de la Suite en el reloj (23 caracteres, sin acentos); null sin nombre. */
  nombre_para_reloj: string | null;
  /** `[RH.14.4]` Su nombre es el apodo del reloj o tiene menos de 3 palabras (la regla de «nombres por confirmar»). */
  nombre_por_confirmar: 'apodo_del_reloj' | 'menos_de_3_palabras' | null;
  /** Plazas activas de la persona, contando ésta. */
  plazas_activas: number;
}

/** `[RH.14.5]` `GET /hr/attendance/enrollments/catalogs` — lo que se elige en la ficha. */
export interface HrCatalogosFichaDto {
  departamentos: Array<{ code: string; name: string }>;
  puestos: Array<{ code: string; name: string; department_code: string | null }>;
  sucursales: Array<{ code: string; name: string; zone_name: string | null }>;
}

/** `[RH.14.4]` `GET /hr/attendance/enrollments/names-to-confirm` — personas activas (con o sin acceso) cuyo nombre es un apodo. */
export interface HrNombrePorConfirmarDto {
  user_id: string;
  nombre: string;
  motivo: 'apodo_del_reloj' | 'menos_de_3_palabras';
  /** El apodo de su reloj (el primero que tenga), para reconocerla. */
  nombre_reloj: string | null;
  /** Sus plazas activas: el nombre se guarda por la primera y se puede mandar a los relojes de todas. */
  plazas: Array<{ site_code: string; site_name: string; person_code: string }>;
  /** La última vez que algún reloj la reportó como enrolada (`last_seen_at`): NO es su última checada. */
  visto_en_reloj: string | null;
}

export interface HrNombresPorConfirmarResponse {
  filas: HrNombrePorConfirmarDto[];
  total: number;
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

// ── `[RH.15.5]` La firma de la semana (LFT 132-XXXIV: el registro hace prueba plena si se acredita el acuerdo) ──

/** Una hoja firmada: un departamento, las personas que firmaron y el jefe de área. */
export interface HrFirmaSemanaDto {
  id: string;
  department: string;
  person_codes: string[];
  jefe_nombre: string;
  file_name: string | null;
  file_type: string | null;
  notes: string | null;
  created_at: string;
  created_by_name: string | null;
  /** Firmó la versión de la semana que está cerrada hoy. `false` = la semana se reabrió y cambió: hay que volver a firmar. */
  vigente: boolean;
  voided_at: string | null;
  void_reason: string | null;
}

/** `[RH.15.11]` Por dónde firmó una persona la versión vigente de su semana. */
export type HrFirmaVia = 'papel' | 'celular';

/** Un departamento de la semana cerrada: quiénes debían firmar y quiénes ya firmaron (en una hoja vigente). */
export interface HrFirmaDepartamentoDto {
  department: string;
  personas: Array<{
    codigo: string; nombre: string; firmo: boolean;
    /** `[RH.15.11]` Por dónde firmó (`null` si no ha firmado). */
    via?: HrFirmaVia | null;
    /** `[RH.15.11]` Su firma del celular (para verla o anularla) y cuándo la hizo. */
    firma_id?: string | null;
    firmado_at?: string | null;
    /** `[RH.15.11]` Tiene un QR vivo sin usar. */
    liga?: boolean;
  }>;
  firmaron: number;
  total: number;
}

/** `GET /hr/attendance/signoffs?site_code&period_start` — cómo va la firma de una semana. */
export interface HrFirmasSemanaDto {
  site_code: string;
  period_start: string;
  /** La semana tiene un cierre vigente. Sin cierre no se firma: se firma lo que quedó cerrado. */
  cerrada: boolean;
  closure_id: string | null;
  departamentos: HrFirmaDepartamentoDto[];
  hojas: HrFirmaSemanaDto[];
  firmaron: number;
  total: number;
}

/** `POST /hr/attendance/signoffs` — la hoja escaneada (PDF o foto) como data URI. */
export interface HrRegistrarFirmaBody {
  site_code: string;
  period_start: string;
  department: string;
  person_codes: string[];
  jefe_nombre: string;
  file_data_uri: string;
  file_name?: string;
  notes?: string;
}

// ── `[RH.15.9]` El registro para la autoridad (LFT 132-XXXIV y 804-III) ──────────────────────────────────

/** Una checada tal como la entregó el reloj. `desfase_s` null = no medido (anterior a RH.15.4). */
export interface HrRegistroLegalFila {
  fecha: string;
  hora: string;
  instante: string;
  reloj: string;
  metodo: string;
  tipo: string;
  origen: string;
  desfase_s: number | null;
}

/** `GET /hr/attendance/registro?site_code&person_code&date_from&date_to` — el CSV y su huella sha256. */
export interface HrRegistroLegalDto {
  site_code: string;
  person_code: string;
  persona_nombre: string | null;
  date_from: string;
  date_to: string;
  generado: string;
  filas: number;
  csv: string;
  sha256: string;
}

// ── `[RH.15.0]` `[RH.15.7]` `[RH.15.8]` Cumplimiento de una plaza ──────────────────────────────

/** `GET /hr/attendance/compliance?site_code` — lo que la ley pide y hoy no se veía. */
export interface HrCumplimientoDto {
  site_code: string;
  hoy: string;
  /** Dadas de baja que el reloj todavía tiene. `pendiente` = ya pasaron los días de gracia. */
  huellasDeBajas: Array<{ codigo: string; nombre: string; baja: string; dias: number; pendiente: boolean }>;
  /** Hasta cuándo se conservan las checadas de cada baja (la baja + 1 año). */
  conservar: Array<{ codigo: string; nombre: string; baja: string; hasta: string }>;
  /** Activas sin checar en una semana: no vinieron, o trabajan sin registrar su jornada. */
  sinRegistro: Array<{ codigo: string; nombre: string; ultima: string | null }>;
}

// ── `[RH.15.11]` La firma desde el celular, con un QR personal: abrir, ver la semana y firmar ──────────────────

/** `POST /hr/attendance/signoffs/digital/links` — genera los QR de un departamento (revoca los anteriores sin usar). */
export interface HrGenerarLigasFirmaBody {
  site_code: string;
  period_start: string;
  department: string;
  /** Sólo estas personas. Sin esto: todas las del departamento que no han firmado. */
  person_codes?: string[];
}

/** Una liga recién generada. ⚠️ El token viaja SÓLO en esta respuesta: la base guarda su huella, no el token. */
export interface HrLigaFirmaDto {
  person_code: string;
  nombre: string;
  url: string;
  expires_at: string;
}

export interface HrLigasFirmaDto {
  site_code: string;
  period_start: string;
  period_end: string;
  department: string;
  ligas: HrLigaFirmaDto[];
  /** Quienes no llevan liga y por qué (ya firmó en papel, ya firmó en el celular). */
  omitidas: Array<{ person_code: string; nombre: string; motivo: string }>;
}

/** Un día de la semana tal como quedó cerrado, en palabras para la persona. */
export interface HrFirmaPublicaDia {
  fecha: string;
  estado: HrEstadoDia;
  /** «Asistió», «Falta», «Descanso»… */
  etiqueta: string;
  entrada: string | null;
  salida: string | null;
  /** Horas trabajadas del día, «8:00». */
  horas: string | null;
  incidencias: string[];
}

/** `GET /hr/attendance/firma/:token` — su semana tal como quedó cerrada, para firmarla. */
export interface HrFirmaPublicaDto {
  /** Nombre completo: la página dice «si no eres Fulano, no firmes». */
  nombre: string;
  site_name: string;
  period_start: string;
  period_end: string;
  expires_at: string;
  dias: HrFirmaPublicaDia[];
  /** Total trabajado en la semana, «48:30». */
  horas_semana: string;
  faltas: number;
}

export interface HrFirmaPublicaFirmarBody {
  /** El trazo como `data:image/png;base64,…`. */
  firma_png: string;
}

export interface HrFirmaPublicaResultadoDto {
  ok: true;
  signed_at: string;
}

/** `POST /hr/attendance/signoffs/digital/signatures/:id/void` — RH anula una firma del celular (p. ej. firmó alguien más). */
export interface HrAnularFirmaDigitalBody {
  motivo: string;
}

/** Una persona en la hoja de firmas: su semana y su firma, si la hay. */
export interface HrHojaFirmaPersona {
  codigo: string;
  nombre: string;
  department: string;
  dias: HrFirmaPublicaDia[];
  horas_semana: string;
  faltas: number;
  /** `null` = no ha firmado esta versión. */
  firma: {
    via: HrFirmaVia;
    /** Hora de México, `YYYY-MM-DDTHH:mm:ss`. */
    firmado_at: string;
    /** El trazo (`data:image/png;base64,…`). Sólo en el celular; en papel, la hoja escaneada se abre aparte. */
    png: string | null;
    ip: string | null;
    navegador: string | null;
    /** Firma del celular o hoja de papel, para abrirla. */
    id: string;
    anulada: { at: string; motivo: string } | null;
  } | null;
}

/**
 * `GET /hr/attendance/signoffs/digital/sheet?site_code&period_start&department` — la hoja de un departamento con todas
 * sus firmas (para el PDF). `GET …/digital/signatures/:id/receipt` — el comprobante de UNA firma, con la versión exacta
 * que se firmó (aunque la semana se haya reabierto después). Mismo tipo: el comprobante trae una sola persona.
 */
export interface HrHojaFirmasDto {
  site_code: string;
  site_name: string;
  period_start: string;
  period_end: string;
  department: string | null;
  /** Huella de la foto del cierre que se firmó (los primeros 12 de su sha256). */
  version: string;
  /** `false` = la semana se reabrió después: esta versión ya no es la vigente. */
  vigente: boolean;
  personas: HrHojaFirmaPersona[];
}

/** Una semana en el expediente de firmas de una persona. */
export interface HrExpedienteFirmaDto {
  site_code: string;
  period_start: string;
  period_end: string;
  department: string;
  via: HrFirmaVia;
  firmado_at: string;
  /** La firma del celular (comprobante) o la hoja de papel (archivo). */
  id: string;
  /** Firmó la versión que está cerrada hoy. */
  vigente: boolean;
  anulada: { at: string; motivo: string } | null;
}

/**
 * `GET /hr/attendance/signoffs/digital/person?user_id` (todas sus plazas) o `?site_code&person_code` (aún sin ligar a su
 * persona) — todas las semanas que firmó, la más nueva primero.
 */
export interface HrExpedienteFirmasDto {
  site_code: string | null;
  person_code: string | null;
  user_id?: string | null;
  firmas: HrExpedienteFirmaDto[];
}
