import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  HrAccionIncidencia, HrAsistenciaResponse, HrCapturaIncidenciaBody, HrCierreDto, HrEstadoDia, HrEstadoIncidencia,
  HrHorarioPersonaBody, HrIncidenciaDto, HrLotePendienteDto, HrOrdenesResponse, HrPasoIncidenciaDto, HrRelojBody,
  HrRelojDto, HrRelojEstadoDto, HrSemaforoReloj, HrSiteDto, HrTipoIncidenciaDto,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * Fase RH · `[RH.1.7]` — el cliente HTTP de las pantallas `/rh/*` (asistencia, incidencias, relojes).
 * Los tipos vienen del contrato (`hr-attendance.contract.ts`): el servidor los construye con los mismos.
 */
@Injectable({ providedIn: 'root' })
export class RhService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/hr/attendance`;

  sitios(): Observable<HrSiteDto[]> {
    return this.http.get<HrSiteDto[]>(`${this.base}/sites`);
  }

  asistencia(q: { site_code: string; date_from: string; date_to: string; only_promoters?: boolean }): Observable<HrAsistenciaResponse> {
    return this.http.get<HrAsistenciaResponse>(`${this.base}/report`, { params: this.params({ ...q, only_promoters: q.only_promoters ? '1' : undefined }) });
  }

  asignarHorario(b: HrHorarioPersonaBody): Observable<{ ok: true; guardados: number }> {
    return this.http.put<{ ok: true; guardados: number }>(`${this.base}/person-schedules`, b);
  }

  quitarHorario(site_code: string, person_codes: string[]): Observable<{ ok: true; quitados: number }> {
    return this.http.post<{ ok: true; quitados: number }>(`${this.base}/person-schedules/remove`, { site_code, person_codes });
  }

  // ── Incidencias y cierres ───────────────────────────────────────────────────────────────

  tiposIncidencia(): Observable<HrTipoIncidenciaDto[]> {
    return this.http.get<HrTipoIncidenciaDto[]>(`${this.base}/incidents/types`);
  }

  incidencias(q: { site_code: string; date_from: string; date_to: string; statuses?: string; person_code?: string }): Observable<HrIncidenciaDto[]> {
    return this.http.get<HrIncidenciaDto[]>(`${this.base}/incidents`, { params: this.params(q) });
  }

  bitacora(id: string): Observable<HrPasoIncidenciaDto[]> {
    return this.http.get<HrPasoIncidenciaDto[]>(`${this.base}/incidents/${encodeURIComponent(id)}/log`);
  }

  capturar(b: HrCapturaIncidenciaBody): Observable<HrIncidenciaDto> {
    return this.http.post<HrIncidenciaDto>(`${this.base}/incidents`, b);
  }

  paso(id: string, accion: HrAccionIncidencia, reason?: string): Observable<HrIncidenciaDto> {
    return this.http.post<HrIncidenciaDto>(`${this.base}/incidents/${encodeURIComponent(id)}/${accion}`, { reason: reason ?? '' });
  }

  cierres(site_code: string): Observable<HrCierreDto[]> {
    return this.http.get<HrCierreDto[]>(`${this.base}/closures`, { params: this.params({ site_code }) });
  }

  cerrarSemana(site_code: string, period_start: string): Observable<HrCierreDto> {
    return this.http.post<HrCierreDto>(`${this.base}/closures`, { site_code, period_start });
  }

  reabrirSemana(id: string, reason: string): Observable<HrCierreDto> {
    return this.http.post<HrCierreDto>(`${this.base}/closures/${encodeURIComponent(id)}/reopen`, { reason });
  }

  // ── Relojes ─────────────────────────────────────────────────────────────────────────────

  relojes(): Observable<HrRelojDto[]> {
    return this.http.get<HrRelojDto[]>(`${this.base}/devices`);
  }

  estadoRelojes(): Observable<HrRelojEstadoDto[]> {
    return this.http.get<HrRelojEstadoDto[]>(`${this.base}/devices/status`);
  }

  guardarReloj(serie: string, b: HrRelojBody): Observable<HrRelojDto> {
    return this.http.put<HrRelojDto>(`${this.base}/devices/${encodeURIComponent(serie)}`, b);
  }

  lotesPendientes(): Observable<HrLotePendienteDto[]> {
    return this.http.get<HrLotePendienteDto[]>(`${this.base}/devices/pending-batches`);
  }

  reprocesar(serie: string): Observable<{ lotes: number; aplicados: number; aceptadas: number }> {
    return this.http.post<{ lotes: number; aplicados: number; aceptadas: number }>(`${this.base}/devices/${encodeURIComponent(serie)}/reprocess`, {});
  }

  ordenes(q: { site_code: string; person_code?: string }): Observable<HrOrdenesResponse> {
    return this.http.get<HrOrdenesResponse>(`${this.base}/devices/commands`, { params: this.params(q) });
  }

  renombrar(site_code: string, person_code: string, name: string): Observable<{ ok: true; nombre: string; relojes: number }> {
    return this.http.post<{ ok: true; nombre: string; relojes: number }>(`${this.base}/devices/commands/rename`, { site_code, person_code, name });
  }

  restaurar(site_code: string, person_code: string): Observable<{ ok: true; relojes: number }> {
    return this.http.post<{ ok: true; relojes: number }>(`${this.base}/devices/commands/restore`, { site_code, person_code });
  }

  cancelarOrden(id: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/devices/commands/${encodeURIComponent(id)}/cancel`, {});
  }

  /** Sólo manda los parámetros con valor. */
  private params(q: object): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return p;
  }
}

/** El mensaje del servidor en palabras de RH, o uno de respaldo. */
export function rhError(e: unknown, fallback: string): string {
  if (e instanceof HttpErrorResponse) {
    const m = (e.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(m)) return m.join(' · ');
    if (typeof m === 'string' && m) return m;
    if (e.status === 403) return 'Tu rol no tiene permiso para esta acción.';
    if (e.status === 0) return 'Sin conexión con el servidor.';
  }
  return fallback;
}

// ── Semana de nómina: de jueves a miércoles ─────────────────────────────────────────────────

/** 'yyyy-MM-dd' ± n días, a mediodía UTC (ningún huso corre el día). */
export function sumarDias(fecha: string, n: number): string {
  return new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** El jueves que abre la semana de nómina de esa fecha (la misma regla que el servidor). */
export function juevesDeLaSemana(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return sumarDias(fecha, -((d.getUTCDay() - 4 + 7) % 7));
}

/** Hoy en México, 'yyyy-MM-dd'. */
export function hoyEnMexico(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «jue 1 oct». */
export function fechaCorta(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}

/** «jue 1 oct – mié 7 oct». */
export function etiquetaSemana(jueves: string): string {
  return `${fechaCorta(jueves)} – ${fechaCorta(sumarDias(jueves, 6))}`;
}

/** Minutos → «1 h 05 min» / «25 min» / «—». */
export function minutosTexto(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

// ── Etiquetas ────────────────────────────────────────────────────────────────────────────

export const ESTADO_DIA_LABEL: Record<HrEstadoDia, string> = {
  a_tiempo: 'A tiempo', absorbido: 'Tolerancia', retardo: 'Retardo', falta: 'Falta',
  descanso: 'Descanso', marca_faltante: 'Una sola marca', justificado: 'Justificado',
};

export const ESTADO_INCIDENCIA_LABEL: Record<HrEstadoIncidencia, string> = {
  capturada: 'Por calificar', calificada: 'Calificada', rechazada: 'Rechazada',
  cerrada: 'Cerrada en prenómina', auditada: 'Auditada', anulada: 'Anulada',
};

export const BANDERA_LABEL: Record<string, string> = {
  corrimiento_60: 'Corre la entrada 1 h o más', hd_frecuente: '3+ horarios distintos en 30 días',
  autocalificada: 'La calificó quien la capturó', sin_nota: 'Sin nota que la respalde', retroactiva: 'Capturada más de 7 días después',
};

export const SEMAFORO_LABEL: Record<HrSemaforoReloj, string> = {
  ok: 'Al día', atrasado: 'Atrasado', mudo: 'Sin señal', pendiente: 'En pausa',
};

/** «hace 3 min», «hace 2 h», «hace 4 d», o «nunca». */
export function haceCuanto(segundos: number | null | undefined): string {
  if (segundos == null) return 'nunca';
  if (segundos < 90) return 'hace un momento';
  if (segundos < 3600) return `hace ${Math.round(segundos / 60)} min`;
  if (segundos < 172800) return `hace ${Math.round(segundos / 3600)} h`;
  return `hace ${Math.round(segundos / 86400)} d`;
}
