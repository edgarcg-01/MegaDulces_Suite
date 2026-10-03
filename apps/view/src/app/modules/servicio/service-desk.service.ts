import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  SdAgentDto, SdAssignDto, SdCatalogResponse, SdChangePriorityDto, SdChangeStatusDto, SdConfigResponse,
  SdCreateRequestDto, SdListResponse, SdLogTimeDto, SdNotificationDto, SdPostMessageDto, SdPreferencesDto,
  SdPriority, SdRequestDetail, SdSettingsDto, SdSlaPolicyDto, SdSlaScanResult, SdStatsResponse, SdStatus,
  SdUpdatePreferencesDto, SdUpsertCategoryDto, SdUpsertQueueDto, SdImpact, SdRoutingResponse, SdUpsertRoutingRuleDto, SdReportResponse, SdRequesterDto, SdDepartmentDto,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

export const PRIORITY_LABEL: Readonly<Record<SdPriority, string>> = { baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente' };
export const STATUS_LABEL: Readonly<Record<SdStatus, string>> = {
  nuevo: 'Nuevo', asignado: 'Asignado', en_proceso: 'En proceso', en_espera: 'En espera',
  resuelto: 'Resuelto', cerrado: 'Cerrado', cancelado: 'Cancelado',
};
export const IMPACT_LABEL: Readonly<Record<SdImpact, string>> = {
  yo: 'Sólo a mí', varios: 'A varias personas', sucursal: 'A toda mi sucursal', red: 'A toda la red',
};

/** Texto de un error HTTP para mostrar en pantalla (el servidor ya manda la razón en español). */
export function sdError(e: unknown, fallback: string): string {
  if (e instanceof HttpErrorResponse) {
    const m = (e.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(m)) return m.join(' · ');
    if (typeof m === 'string' && m) return m;
    if (e.status === 403) return 'Tu rol no tiene permiso para esta acción.';
    if (e.status === 413) return 'El archivo es demasiado grande para el servidor.';
    if (e.status === 0) return 'Sin conexión con el servidor.';
  }
  return fallback;
}

/** Mensaje del SLA para mostrar: «Vence en 2 h», «Venció hace 1 d», «En pausa». */
export function slaTexto(sla: SdRequestDetail['sla'], status: SdStatus, now = Date.now()): { texto: string; tono: 'ok' | 'warn' | 'bad' | 'mute' } {
  if (status === 'cerrado' || status === 'cancelado' || status === 'resuelto') return { texto: '—', tono: 'mute' };
  if (sla.paused) return { texto: 'En pausa', tono: 'mute' };
  if (!sla.due_at) return { texto: 'Sin plazo', tono: 'mute' };
  const ms = new Date(sla.due_at).getTime() - now;
  const abs = Math.abs(ms);
  const h = abs / 3_600_000;
  const t = h < 1 ? `${Math.max(1, Math.round(abs / 60_000))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  if (ms < 0 || sla.resolution_breached) return { texto: `Venció hace ${t}`, tono: 'bad' };
  return { texto: `Vence en ${t}`, tono: (sla.used_ratio ?? 0) >= 0.8 ? 'warn' : 'ok' };
}

@Injectable({ providedIn: 'root' })
export class ServiceDeskService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/service-desk`;

  catalog(): Observable<SdCatalogResponse> { return this.http.get<SdCatalogResponse>(`${this.base}/catalog`); }
  agents(): Observable<SdAgentDto[]> { return this.http.get<SdAgentDto[]>(`${this.base}/agents`); }

  create(dto: SdCreateRequestDto): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests`, dto); }
  mine(q: { scope?: string; search?: string; limit?: number; offset?: number } = {}): Observable<SdListResponse> {
    return this.http.get<SdListResponse>(`${this.base}/requests/mine`, { params: this.params(q) });
  }
  inbox(q: { scope?: string; queue_id?: string; priority?: string; status?: string; warehouse_code?: string; search?: string; limit?: number; offset?: number } = {}): Observable<SdListResponse> {
    return this.http.get<SdListResponse>(`${this.base}/requests/inbox`, { params: this.params(q) });
  }
  stats(): Observable<SdStatsResponse> { return this.http.get<SdStatsResponse>(`${this.base}/requests/stats`); }
  detail(id: string): Observable<SdRequestDetail> { return this.http.get<SdRequestDetail>(`${this.base}/requests/${id}`); }

  message(id: string, dto: SdPostMessageDto): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/messages`, dto); }
  status(id: string, dto: SdChangeStatusDto): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/status`, dto); }
  confirm(id: string, note?: string): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/confirm`, { note }); }
  reopen(id: string, note: string): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/reopen`, { note }); }
  cancel(id: string, note?: string): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/cancel`, { note }); }
  take(id: string): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/take`, {}); }
  assign(id: string, dto: SdAssignDto): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/assign`, dto); }
  priority(id: string, dto: SdChangePriorityDto): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/priority`, dto); }
  logTime(id: string, dto: SdLogTimeDto): Observable<SdRequestDetail> { return this.http.post<SdRequestDetail>(`${this.base}/requests/${id}/time`, dto); }

  notifications(since?: string): Observable<SdNotificationDto[]> {
    return this.http.get<SdNotificationDto[]>(`${this.base}/me/notifications`, { params: this.params({ since }) });
  }
  preferences(): Observable<SdPreferencesDto> { return this.http.get<SdPreferencesDto>(`${this.base}/me/preferences`); }
  updatePreferences(dto: SdUpdatePreferencesDto): Observable<SdPreferencesDto> { return this.http.put<SdPreferencesDto>(`${this.base}/me/preferences`, dto); }

  config(): Observable<SdConfigResponse> { return this.http.get<SdConfigResponse>(`${this.base}/config`); }
  updateSettings(dto: Partial<SdSettingsDto>): Observable<SdConfigResponse> { return this.http.put<SdConfigResponse>(`${this.base}/config/settings`, dto); }
  updatePolicy(priority: SdPriority, dto: Partial<Omit<SdSlaPolicyDto, 'priority'>>): Observable<SdConfigResponse> {
    return this.http.put<SdConfigResponse>(`${this.base}/config/policies/${priority}`, dto);
  }
  createQueue(dto: SdUpsertQueueDto): Observable<SdConfigResponse> { return this.http.post<SdConfigResponse>(`${this.base}/config/queues`, dto); }
  updateQueue(id: string, dto: SdUpsertQueueDto): Observable<SdConfigResponse> { return this.http.put<SdConfigResponse>(`${this.base}/config/queues/${id}`, dto); }
  createCategory(dto: SdUpsertCategoryDto): Observable<SdConfigResponse> { return this.http.post<SdConfigResponse>(`${this.base}/config/categories`, dto); }
  updateCategory(id: string, dto: SdUpsertCategoryDto): Observable<SdConfigResponse> { return this.http.put<SdConfigResponse>(`${this.base}/config/categories/${id}`, dto); }
  /** `[MS.3.11]` Personas para levantar una solicitud a su nombre. Sólo quien atiende; mínimo 2 letras. */
  requesters(search: string): Observable<SdRequesterDto[]> {
    return this.http.get<SdRequesterDto[]>(`${this.base}/requesters`, { params: this.params({ search }) });
  }
  departments(): Observable<SdDepartmentDto[]> { return this.http.get<SdDepartmentDto[]>(`${this.base}/departments`); }
  report(from?: string, to?: string): Observable<SdReportResponse> {
    return this.http.get<SdReportResponse>(`${this.base}/reports`, { params: this.params({ from, to }) });
  }
  routing(): Observable<SdRoutingResponse> { return this.http.get<SdRoutingResponse>(`${this.base}/config/routing`); }
  createRouting(dto: SdUpsertRoutingRuleDto): Observable<SdRoutingResponse> { return this.http.post<SdRoutingResponse>(`${this.base}/config/routing`, dto); }
  updateRouting(id: string, dto: SdUpsertRoutingRuleDto): Observable<SdRoutingResponse> { return this.http.put<SdRoutingResponse>(`${this.base}/config/routing/${id}`, dto); }
  removeRouting(id: string): Observable<SdRoutingResponse> { return this.http.delete<SdRoutingResponse>(`${this.base}/config/routing/${id}`); }
  scanNow(): Observable<SdSlaScanResult> { return this.http.post<SdSlaScanResult>(`${this.base}/sla/scan-now`, {}); }

  /** Sólo manda los parámetros con valor: un `?search=` vacío no filtra pero ensucia la URL y el log. */
  private params(q: Record<string, string | number | undefined>): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return p;
  }
}
