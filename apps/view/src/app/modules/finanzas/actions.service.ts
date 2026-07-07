import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** MAAT.9 (3.0 HITL) — cliente de acciones propuestas por Maat (aprobar/rechazar). */

export type ActionEstado = 'pending_approval' | 'approved' | 'rejected' | 'executed' | 'failed';
export interface ProposedAction {
  id: string;
  kind: string;
  titulo: string;
  descripcion: string | null;
  efecto: string | null;
  estado: ActionEstado;
  origen: string;
  finding_id: string | null;
  importe: number;
  created_by: string | null;
  decided_by: string | null;
  resultado: string | null;
  created_at: string;
}

@Injectable({ providedIn: 'root' })
export class ActionsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/maat/actions`;

  list(estado?: string): Observable<ProposedAction[]> {
    return this.http.get<ProposedAction[]>(`${this.base}${estado ? '?estado=' + estado : ''}`);
  }
  approve(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/approve`, {}); }
  reject(id: string, nota?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { nota }); }
}
