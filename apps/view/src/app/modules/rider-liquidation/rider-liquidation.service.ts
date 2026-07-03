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
}
