import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.8.1 — cliente DIOT + resumen de IVA. /fiscal/diot. Operations. */

export interface DiotRow {
  rfc: string; nombre: string | null; tipo_tercero: string; tipo_operacion: string;
  base: number | string; iva16: number | string; iva_retenido: number | string; num_cfdis: number;
}
export interface DiotResult {
  period: string;
  rows: DiotRow[];
  totales: { base: number; iva16: number; iva_retenido: number; proveedores: number };
}
export interface IvaResumen {
  period: string; iva_acreditable: number; iva_trasladado: number; iva_retenido: number;
  iva_a_cargo: number; iva_a_favor: number;
}

@Injectable({ providedIn: 'root' })
export class DiotService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/diot`;

  build(period: string): Observable<DiotResult> { return this.http.get<DiotResult>(`${this.base}?period=${encodeURIComponent(period)}`); }
  iva(period: string): Observable<IvaResumen> { return this.http.get<IvaResumen>(`${this.base}/iva?period=${encodeURIComponent(period)}`); }
}
