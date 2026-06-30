import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** TC.4a/5a — Curaduría de ejemplos verificados de Thot Chat (back-office). */
export interface ThotExampleRow {
  id: string;
  profile: string;
  question: string;
  answer: string | null;
  tools: any[];
  note: string | null;
  enabled: boolean;
  created_at: string;
}
export interface ThotCandidateRow {
  id: string;
  question: string;
  answer: string | null;
  tools_used: any[];
  user_name: string | null;
  created_at: string;
}

@Injectable({ providedIn: 'root' })
export class ThotCurationService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/intelligence/thot`;

  listExamples(profile?: string): Observable<ThotExampleRow[]> {
    let p = new HttpParams();
    if (profile) p = p.set('profile', profile);
    return this.http.get<ThotExampleRow[]>(`${this.base}/examples`, { params: p });
  }
  candidates(limit = 30): Observable<ThotCandidateRow[]> {
    return this.http.get<ThotCandidateRow[]>(`${this.base}/examples/candidates`, { params: new HttpParams().set('limit', String(limit)) });
  }
  add(dto: { profile?: string; question: string; answer?: string; tools?: any[]; note?: string }) {
    return this.http.post<{ id: string }>(`${this.base}/examples`, dto);
  }
  promote(logId: string, dto: { note?: string; profile?: string } = {}) {
    return this.http.post<{ id: string }>(`${this.base}/examples/from-log/${logId}`, dto);
  }
  toggle(id: string, enabled: boolean) {
    return this.http.patch<{ id: string; enabled: boolean }>(`${this.base}/examples/${id}`, { enabled });
  }
}
