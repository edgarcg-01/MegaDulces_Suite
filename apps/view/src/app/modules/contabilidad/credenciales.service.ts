import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.2 — cliente de la bóveda de credenciales SAT (e.firma). /fiscal/credentials. */

export interface CredStatus {
  rfc: string; razon_social: string | null; cer_valid_to: string | null;
  dias_para_vencer: number | null; vigente: boolean; active: boolean; vault_ok: boolean;
}
export interface UpsertCred {
  rfc: string; razon_social?: string; cer_b64: string; key_b64: string; password: string; ciec?: string;
}

@Injectable({ providedIn: 'root' })
export class CredencialesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/credentials`;

  status(): Observable<CredStatus[]> { return this.http.get<CredStatus[]>(`${this.base}/status`); }
  upsert(body: UpsertCred): Observable<{ rfc: string; cer_valid_to: string | null; vigente: boolean }> { return this.http.post<{ rfc: string; cer_valid_to: string | null; vigente: boolean }>(this.base, body); }
  remove(rfc: string): Observable<{ removed: number }> { return this.http.delete<{ removed: number }>(`${this.base}/${encodeURIComponent(rfc)}`); }
}
