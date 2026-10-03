/**
 * `[MS.2.2]` Mesa de Servicio (Fase MS, ADR-081) — el contrato HTTP.
 *
 * El productor (`libs/service-desk`) y el consumidor (`apps/view`, pantallas de MS.3) importan de acá.
 * **Sólo tipos y constantes pequeñas**: este barril lo cargan las tres apps Angular desde el arranque.
 *
 * ⚠️ A propósito NO hay un `generated_at` en ninguna respuesta: son datos transaccionales vivos, y
 * `npm run check:provenance` exige `freshness`/`data_as_of` a toda interfaz que lo declare.
 *
 * ── Vocabulario ────────────────────────────────────────────────────────────────────────────
 * Los literales son los de los CHECK de `servicedesk.*` (migraciones 20261002100000-170000): la base
 * rechaza cualquier otro valor, así que un tipo acá que difiera es un tipo que miente.
 */

export const SD_PRIORITIES = ['baja', 'media', 'alta', 'urgente'] as const;
export type SdPriority = (typeof SD_PRIORITIES)[number];

export const SD_STATUSES = [
  'nuevo',
  'asignado',
  'en_proceso',
  'en_espera',
  'resuelto',
  'cerrado',
  'cancelado',
] as const;
export type SdStatus = (typeof SD_STATUSES)[number];

/** Estados en los que el ticket sigue siendo trabajo VIVO (cuenta para el SLA y para la bandeja). */
export const SD_OPEN_STATUSES: readonly SdStatus[] = ['nuevo', 'asignado', 'en_proceso', 'en_espera', 'resuelto'];

export const SD_IMPACTS = ['yo', 'varios', 'sucursal', 'red'] as const;
export type SdImpact = (typeof SD_IMPACTS)[number];

export const SD_CHANNELS = ['web', 'vendor', 'public_link', 'whatsapp', 'bitacora'] as const;
export type SdChannel = (typeof SD_CHANNELS)[number];

export const SD_MESSAGE_KINDS = ['comment', 'status', 'assignment', 'priority', 'system', 'internal_note'] as const;
export type SdMessageKind = (typeof SD_MESSAGE_KINDS)[number];

export type SdVisibility = 'public' | 'internal';
export type SdClock = 'business' | 'calendar';
export type SdCloseReason = 'confirmado' | 'auto' | 'cancelado';

/** Quién actúa. Decide qué transiciones y qué datos se permiten (ver `domain/request-state.ts`). */
export type SdActor = 'requester' | 'agent' | 'coordinator' | 'system';

// ── Catálogo (lo que la pantalla «Nueva solicitud» necesita para pintarse) ─────────────────────

export interface SdQueueDto {
  id: string;
  code: string;
  name: string;
}

export interface SdCategoryDto {
  id: string;
  queue_id: string;
  code: string;
  name: string;
  default_priority: SdPriority;
  requires_branch: boolean;
}

export interface SdCatalogResponse {
  queues: SdQueueDto[];
  categories: SdCategoryDto[];
  impacts: readonly SdImpact[];
}

// ── Solicitudes ─────────────────────────────────────────────────────────────────────────────────

export interface SdAttachmentInput {
  /** `data:<mime>;base64,<...>` — se valida por FIRMA en el servidor, no por el tipo declarado. */
  file_base64: string;
  file_name?: string;
}

export interface SdCreateRequestDto {
  category_id: string;
  title: string;
  description?: string;
  impact?: SdImpact;
  /** «Me bloquea el trabajo». Con el impacto, alimenta la prioridad SUGERIDA; no la fija. */
  blocks_work?: boolean;
  /** Código de sucursal (`'01'`…). Obligatorio si la categoría exige sucursal. */
  warehouse_code?: string | null;
  attachments?: SdAttachmentInput[];
  /**
   * `[MS.3.11]` Levantar la solicitud A NOMBRE DE otra persona. **Sólo quien atiende** (`ATENDER`/`COORDINAR`): para
   * cualquier otro es 403. La persona debe tener usuario; es quien recibe los avisos y quien confirma o reabre.
   * Ausente = el solicitante es quien llama (lo de siempre).
   */
  requester_id?: string | null;
  /**
   * `[MS.3.11]` Departamento (área) del solicitante. Ausente = el de la ficha de esa persona. Sólo quien atiende.
   */
  department_code?: string | null;
}

/** `[MS.3.11]` Una persona que puede figurar como solicitante. Sin correo ni teléfono: sólo lo que hace falta para elegir. */
export interface SdRequesterDto {
  user_id: string;
  username: string;
  name: string | null;
  department_code: string | null;
  department_name: string | null;
  position_code: string | null;
  /** Sucursal de su ficha, para precargar el formulario (editable). `null` = la ficha no la tiene. */
  warehouse_code: string | null;
  warehouse_name: string | null;
}

export interface SdDepartmentDto {
  code: string;
  name: string;
}

export interface SdSlaView {
  /** `null` = la política no tiene plazo (no debería pasar) — NO es «no vence». */
  first_response_due_at: string | null;
  due_at: string | null;
  first_responded_at: string | null;
  paused: boolean;
  first_breached: boolean;
  resolution_breached: boolean;
  /** Fracción del plazo de resolución ya consumida, 0..1+. `null` si no se puede medir. */
  used_ratio: number | null;
}

export interface SdRequestRow {
  id: string;
  folio: string;
  queue_id: string;
  queue_name: string | null;
  category_id: string;
  category_name: string | null;
  title: string;
  priority: SdPriority;
  priority_suggested: SdPriority | null;
  impact: SdImpact;
  blocks_work: boolean;
  status: SdStatus;
  requester_id: string;
  requester_name: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  assigned_at: string | null;
  created_at: string;
  updated_at: string;
  sla: SdSlaView;
}

export interface SdMessageDto {
  id: string;
  kind: SdMessageKind;
  visibility: SdVisibility;
  author_id: string | null;
  author_label: string | null;
  body: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface SdAttachmentDto {
  id: string;
  message_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  /** URL prefirmada, fresca en cada lectura. Nunca se guarda. */
  url: string;
  created_at: string;
}

export interface SdRequestDetail extends SdRequestRow {
  description: string;
  requester_department_code: string | null;
  /** `[MS.3.11]` Nombre del departamento (el código solo no le dice nada a nadie). */
  requester_department_name: string | null;
  /** `[MS.3.11]` Quién la levantó, cuando NO es el solicitante (la abrió alguien que atiende a su nombre). `null` = ella misma. */
  opened_by_name: string | null;
  requester_position_code: string | null;
  channel: SdChannel;
  resolved_at: string | null;
  resolution_note: string | null;
  closed_at: string | null;
  close_reason: SdCloseReason | null;
  reopened_count: number;
  /** El solicitante NO recibe las notas internas: este arreglo ya viene filtrado por el servidor. */
  messages: SdMessageDto[];
  attachments: SdAttachmentDto[];
  /** Minutos registrados en `work_log`. Sólo lo ve quien atiende. */
  time_logged_minutes: number | null;
}

export interface SdListResponse {
  rows: SdRequestRow[];
  total: number;
}

export interface SdPostMessageDto {
  body: string;
  /** `internal` sólo lo admite quien atiende; para el solicitante se ignora y se rechaza. */
  visibility?: SdVisibility;
  attachments?: SdAttachmentInput[];
}

export interface SdChangeStatusDto {
  status: SdStatus;
  note?: string;
}

export interface SdAssignDto {
  /** `null`/ausente = tomarlo uno mismo (`take`). */
  user_id?: string | null;
}

export interface SdChangePriorityDto {
  priority: SdPriority;
  reason?: string;
}

export interface SdLogTimeDto {
  minutes: number;
  note?: string;
  started_at?: string;
  ended_at?: string;
}

/** Agente asignable: lo que el selector necesita, SIN exigir `USUARIOS_VER`. */
export interface SdAgentDto {
  user_id: string;
  username: string;
  name: string | null;
  open_count: number;
}

/** Tablero de la coordinación: qué hay abierto y qué se está pasando del plazo. */
export interface SdStatsResponse {
  open_total: number;
  unassigned: number;
  first_response_breached: number;
  resolution_breached: number;
  by_status: Partial<Record<SdStatus, number>>;
  by_priority: Partial<Record<SdPriority, number>>;
}

// ── Reportes (coordinación) ────────────────────────────────────────────────────────────────────

/**
 * `[MS.3.5]` Cumplimiento de un plazo (primera respuesta o resolución) sobre los tickets CREADOS en el periodo.
 *
 * ⛔ `cumplimiento_pct` es `cumplidos / (cumplidos + incumplidos)` y es **`null` cuando no hay con qué juzgar**
 * (ninguno vencido ni resuelto aún): un cero dibujado diría «nadie cumplió». Lo que sigue dentro de plazo y lo que
 * no tiene plazo se cuentan APARTE, no se mezclan con el cumplimiento.
 */
export interface SdSlaCompliance {
  /** Se resolvió/respondió a tiempo. */
  cumplidos: number;
  /** Llegó tarde, o sigue sin respuesta/resolución con el plazo ya vencido. */
  incumplidos: number;
  /** Todavía no vence y todavía no se cumple: no se puede juzgar. */
  en_plazo: number;
  /** El ticket no trae plazo (no debería pasar; se cuenta para que se vea si pasa). */
  sin_plazo: number;
  cumplimiento_pct: number | null;
}

/** Tiempos en MINUTOS del reloj de la política de cada prioridad (hábil o corrido). `null` = ninguno medible. */
export interface SdReportTiming {
  n: number;
  p50: number | null;
  p90: number | null;
}

export interface SdReportPriorityRow {
  priority: SdPriority;
  creados: number;
  resueltos: number;
  primera_respuesta: SdSlaCompliance;
  resolucion: SdSlaCompliance;
  /** Minutos hasta la primera respuesta de quien atiende. */
  t_primera_respuesta: SdReportTiming;
  /** Minutos hasta resolver, SIN contar lo que estuvo en espera del solicitante. */
  t_resolucion: SdReportTiming;
}

export interface SdReportCategoryRow {
  category_id: string;
  name: string;
  creados: number;
  resueltos: number;
  resolucion_incumplidos: number;
  reabiertos: number;
  t_resolucion: SdReportTiming;
}

export interface SdReportBranchRow {
  /** `null` = el ticket no indicó sucursal. */
  warehouse_code: string | null;
  warehouse_name: string | null;
  creados: number;
  resueltos: number;
  resolucion_incumplidos: number;
}

/** Misma categoría en la misma sucursal, repetida: lo que probablemente es un problema de fondo y no un ticket suelto. */
export interface SdReportRecurringRow {
  category_id: string;
  category_name: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  n: number;
}

export interface SdReportResponse {
  periodo: { desde: string; hasta: string };
  /** Cuándo se calculó (la fuente es la tabla viva de tickets: no hay copia que pueda estar vieja). */
  medido_at: string;
  /** `true` = el periodo trae más tickets de los que el reporte calcula; los números son de los más recientes. */
  truncado: boolean;
  totales: {
    creados: number;
    resueltos: number;
    abiertos: number;
    cancelados: number;
    /** Tickets que alguna vez se reabrieron: la señal de que «resuelto» no resolvió. */
    reabiertos: number;
    reabiertos_pct: number | null;
  };
  primera_respuesta: SdSlaCompliance;
  resolucion: SdSlaCompliance;
  por_prioridad: SdReportPriorityRow[];
  por_categoria: SdReportCategoryRow[];
  por_sucursal: SdReportBranchRow[];
  recurrentes: SdReportRecurringRow[];
  /** Lo que este reporte NO puede contestar, dicho en voz alta (no se dibuja como cero). */
  no_medido: string[];
}

// ── Avisos y preferencias ───────────────────────────────────────────────────────────────────────

/** Un aviso de la campana. Sale de `servicedesk.notification_log` (canal `app`): el worker no tiene WebSocket. */
export interface SdNotificationDto {
  id: string;
  event: string;
  request_id: string | null;
  folio: string | null;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  created_at: string;
}

export interface SdPreferencesDto {
  email: string | null;
  /** Canónico `52XXXXXXXXXX`. */
  phone: string | null;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  /** Cuándo aceptó recibir WhatsApp. Sin esta fecha el canal no se activa. */
  whatsapp_opt_in_at: string | null;
}

export interface SdUpdatePreferencesDto {
  email?: string | null;
  phone?: string | null;
  email_enabled?: boolean;
  whatsapp_enabled?: boolean;
}

// ── Configuración (coordinación) ────────────────────────────────────────────────────────────────

export interface SdSettingsDto {
  /** 0 = domingo … 6 = sábado. */
  business_days: number[];
  /** `HH:MM`. */
  business_start: string;
  business_end: string;
  tz: string;
  auto_close_days: number;
  escalate_at_pct: number;
  /** Apagado de fábrica: primero se MIDE el SLA, después se escala. */
  escalation_enabled: boolean;
  max_attachment_mb: number;
  /**
   * `[MS.3.8]` Minutos HÁBILES que el ticket más viejo SIN ASIGNAR puede esperar antes de que «Mi trabajo» marque la
   * cola como atrasada (5 a 1440; arranca en 60). Es política, no medición: se ajusta aquí y se lee en cada carga.
   */
  unassigned_alert_minutes: number;
}

// ── Asignación automática (coordinación) ───────────────────────────────────────────────────────

/**
 * `[MS.3.10]` Una regla de asignación automática: una persona + lo que dispara la regla (una categoría exacta o
 * palabras clave en lo que escribe quien reporta). Gana la primera por `sort_order`.
 */
export interface SdRoutingRuleDto {
  id: string;
  name: string;
  /** Normalizadas (sin acentos ni mayúsculas). Una palabra del texto que EMPIEZA con la clave la dispara. */
  keywords: string[];
  category_id: string | null;
  category_name: string | null;
  assignee_id: string;
  assignee_name: string | null;
  assignee_username: string;
  /**
   * ¿Esa persona puede atender hoy (tiene `SERVICIO_ATENDER` o `COORDINAR`)? Si no, el ruteo NO le asigna y el
   * ticket queda sin asignar — nunca se le asigna a quien no puede abrir su propia ficha. La pantalla lo marca.
   */
  assignee_ok: boolean;
  sort_order: number;
  active: boolean;
}

export interface SdRoutingResponse {
  rules: SdRoutingRuleDto[];
}

export interface SdUpsertRoutingRuleDto {
  name?: string;
  keywords?: string[];
  category_id?: string | null;
  assignee_id?: string;
  sort_order?: number;
  active?: boolean;
}

export interface SdSlaPolicyDto {
  priority: SdPriority;
  first_response_minutes: number;
  resolution_minutes: number;
  clock: SdClock;
}

export interface SdQueueAdminDto extends SdQueueDto {
  department_code: string | null;
  active: boolean;
  sort_order: number;
}

export interface SdCategoryAdminDto extends SdCategoryDto {
  active: boolean;
  sort_order: number;
}

export interface SdConfigResponse {
  settings: SdSettingsDto;
  policies: SdSlaPolicyDto[];
  queues: SdQueueAdminDto[];
  categories: SdCategoryAdminDto[];
}

export interface SdUpsertCategoryDto {
  queue_id?: string;
  code?: string;
  name?: string;
  default_priority?: SdPriority;
  requires_branch?: boolean;
  active?: boolean;
  sort_order?: number;
}

export interface SdUpsertQueueDto {
  code?: string;
  name?: string;
  department_code?: string | null;
  active?: boolean;
  sort_order?: number;
}

/** Lo que midió un barrido del SLA (también lo devuelve `POST /sla/scan-now`). */
export interface SdSlaScanResult {
  tenants: number;
  /** Tickets que cruzaron por primera vez un plazo y quedaron marcados. */
  marcados: number;
  /** Avisos de «por vencer» / «vencido» que salieron (0 mientras la escalación esté apagada). */
  avisos: number;
  /** Resueltos que nadie confirmó y se cerraron solos. */
  autocerrados: number;
}
