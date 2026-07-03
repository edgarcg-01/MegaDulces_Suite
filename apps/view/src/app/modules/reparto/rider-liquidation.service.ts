import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** Corte de caja del repartidor (arqueo). Back-office del encargado (§11–12). */
export interface RiderLiquidation {
  id: string;
  rider_user_id: string;
  branch_store_id: string | null;
  business_date: string;
  folio: string | null;
  deliveries_count: number;
  cash_expected: number | string;
  cash_counted: number | string | null;
  cash_difference: number | string | null;
  transfer_total: number | string;
  card_total: number | string;
  incidents_count: number;
  status: 'open' | 'closed' | 'reconciled';
}

export interface FleetDriver { id: string; full_name: string; user_id?: string | null; }

@Injectable({ providedIn: 'root' })
export class RiderLiquidationService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  list(businessDate?: string, status?: string): Observable<RiderLiquidation[]> {
    let p = new HttpParams();
    if (businessDate) p = p.set('business_date', businessDate);
    if (status) p = p.set('status', status);
    return this.http.get<RiderLiquidation[]>(`${this.api}/commercial/rider-liquidations`, { params: p });
  }

  open(dto: { rider_user_id: string; business_date: string; branch_store_id?: string }): Observable<RiderLiquidation> {
    return this.http.post<RiderLiquidation>(`${this.api}/commercial/rider-liquidations`, dto);
  }

  preview(id: string): Observable<RiderLiquidation> {
    return this.http.get<RiderLiquidation>(`${this.api}/commercial/rider-liquidations/${id}/preview`);
  }

  close(id: string, cashBreakdown: Record<string, number>, notes?: string): Observable<RiderLiquidation> {
    return this.http.post<RiderLiquidation>(`${this.api}/commercial/rider-liquidations/${id}/close`, {
      cash_breakdown: cashBreakdown,
      notes,
    });
  }

  listDrivers(): Observable<FleetDriver[]> {
    return this.http.get<FleetDriver[]>(`${this.api}/logistics/fleet/drivers`, {
      params: new HttpParams().set('active', 'true'),
    });
  }

  // ── LM.7.1 — verificación de transferencias/tarjetas ──
  pendingVerification(): Observable<PendingPayment[]> {
    return this.http.get<PendingPayment[]>(`${this.api}/commercial/payments/pending-verification`);
  }

  verifyPayment(id: string): Observable<any> {
    return this.http.post(`${this.api}/commercial/payments/${id}/verify`, {});
  }

  // ── LM.8 — KPIs de última milla ──
  kpis(from?: string, to?: string): Observable<HomeDeliveryKpis> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<HomeDeliveryKpis>(`${this.api}/commercial/home-delivery/kpis`, { params: p });
  }
}

export interface HomeDeliveryKpis {
  deliveries_total: number;
  delivered: number;
  incidents: number;
  success_rate_pct: number;
  incident_rate_pct: number;
  avg_delivery_min: number | null;
  cash_counted: number;
  cash_difference_abs: number;
  card_total: number;
  transfer_total: number;
  cuts_closed: number;
}

export interface PendingPayment {
  id: string;
  amount: number | string;
  payment_method: string;
  reference: string | null;
  proof_url: string | null;
  received_at: string;
  order_id: string | null;
  kepler_folio: string | null;
}
