import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEvent, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export type DevProjectPriority = 'baja' | 'media' | 'alta' | 'urgente';
export type DevProjectStatus = 'nuevo' | 'en_progreso' | 'en_pausa' | 'terminado' | 'cancelado';
export type AttachmentKind = 'documento' | 'imagen' | 'video' | 'audio';
export type AttachmentSource = 'archivo' | 'camara' | 'grabacion';

export interface DevTeamMember {
  user_id: string;
  display_name: string;
  username: string | null;
}

export interface DevProjectAttachment {
  id: string;
  kind: AttachmentKind;
  source: AttachmentSource;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  created_by_username: string | null;
  url: string | null;
}

export interface DevProject {
  id: string;
  folio: string;
  title: string;
  objective: string | null;
  priority: DevProjectPriority;
  status: DevProjectStatus;
  assignee_user_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  created_at: string;
  created_by_username: string | null;
  updated_at: string;
  attachments_count: number;
}

export interface DevProjectDetail extends DevProject {
  attachments: DevProjectAttachment[];
}

export interface DevProjectInput {
  title?: string;
  objective?: string | null;
  priority?: DevProjectPriority;
  status?: DevProjectStatus;
  assignee_user_id?: string | null;
  due_date?: string | null;
}

export const PRIORITY_LABEL: Record<DevProjectPriority, string> = {
  baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente',
};
export const STATUS_LABEL: Record<DevProjectStatus, string> = {
  nuevo: 'Nuevo', en_progreso: 'En progreso', en_pausa: 'En pausa', terminado: 'Terminado', cancelado: 'Cancelado',
};

/** `[DEV.5]` Cliente de `/api/dev/projects`. */
@Injectable({ providedIn: 'root' })
export class DevProjectsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/dev/projects`;

  team(): Observable<DevTeamMember[]> {
    return this.http.get<DevTeamMember[]>(`${this.base}/team`);
  }

  list(f: { status?: string; assignee?: string; search?: string } = {}): Observable<DevProject[]> {
    let params = new HttpParams();
    // Sólo lo que trae valor: un `status=` vacío NO es «todos», es un filtro que no casa con nada.
    for (const [k, v] of Object.entries(f)) if (v) params = params.set(k, v);
    return this.http.get<DevProject[]>(this.base, { params });
  }

  detail(id: string): Observable<DevProjectDetail> {
    return this.http.get<DevProjectDetail>(`${this.base}/${id}`);
  }

  create(body: DevProjectInput): Observable<DevProjectDetail> {
    return this.http.post<DevProjectDetail>(this.base, body);
  }

  update(id: string, body: DevProjectInput): Observable<DevProjectDetail> {
    return this.http.patch<DevProjectDetail>(`${this.base}/${id}`, body);
  }

  remove(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.base}/${id}`);
  }

  /** Multipart con progreso: un video tarda, y una barra que no se mueve se lee como «se trabó». */
  upload(id: string, file: Blob, fileName: string, source: AttachmentSource): Observable<HttpEvent<DevProjectAttachment>> {
    const fd = new FormData();
    fd.append('source', source);
    fd.append('file', file, fileName);
    return this.http.post<DevProjectAttachment>(`${this.base}/${id}/attachments`, fd, {
      reportProgress: true,
      observe: 'events',
    });
  }

  removeAttachment(id: string, attachmentId: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.base}/${id}/attachments/${attachmentId}`);
  }
}
