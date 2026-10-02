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
