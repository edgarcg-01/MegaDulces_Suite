import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** CBW (ADR-042) — cliente de la bandeja de capturas bancarias por WhatsApp. */

export interface BankCapture {
  id: string;
  status: 'pendiente_confirmacion' | 'confirmado' | 'validado' | 'rechazado' | 'descartado';
  from_phone: string;
  sender_name: string | null;
  sucursal: string | null;
  concept: string | null;
  cuenta: string | null;
  amount_in: number;
  amount_out: number;
  movement_date: string | null;
  ocr_banco: string | null;
  ocr_cuenta_dest: string | null;
  ocr_referencia: string | null;
  ocr_status: string;
  files: { url: string; public_id: string; kind: string }[] | string;
  bank_movement_id: string | null;
  notified_at: string | null;
  created_at: string;
}

export interface CaptureKpis {
  pendiente_confirmacion: number; confirmado: number; validado: number;
  rechazado: number; descartado: number; total_monto: number;
}

export interface CapturesPage { rows: BankCapture[]; kpis: CaptureKpis; }

export interface CaptureSender {
  id: string; phone: string; full_name: string; sucursal: string | null;
  default_bank_account_id: string | null; active: boolean; cuenta: string | null;
}

@Injectable({ providedIn: 'root' })
export class BankCaptureService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/bank-captures`;

  list(q: { status?: string; search?: string; limit?: number } = {}): Observable<CapturesPage> {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.search) p.set('search', q.search);
    if (q.limit != null) p.set('limit', String(q.limit));
    return this.http.get<CapturesPage>(`${this.base}?${p.toString()}`);
  }
  validate(id: string): Observable<unknown> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<unknown> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  update(id: string, patch: Partial<BankCapture>): Observable<unknown> { return this.http.patch(`${this.base}/${id}`, patch); }

  senders(): Observable<CaptureSender[]> { return this.http.get<CaptureSender[]>(`${this.base}/senders`); }
  createSender(body: { phone: string; full_name: string; sucursal?: string; default_bank_account_id?: string }): Observable<CaptureSender> {
    return this.http.post<CaptureSender>(`${this.base}/senders`, body);
  }
  updateSender(id: string, patch: Partial<CaptureSender>): Observable<unknown> { return this.http.patch(`${this.base}/senders/${id}`, patch); }
}
