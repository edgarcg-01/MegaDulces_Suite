import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.18 — cliente de impuestos provisionales (ISR + IVA). /fiscal/impuestos. */

export interface ProvisionalParams {
  period: string; cu: number; tasa?: number; ptu?: number; perdidas?: number; pagos_previos?: number; retenido?: number;
}
export interface ProvisionalResult {
  period: string;
  isr: {
    ingresos_nominales_acumulados: number; coeficiente_utilidad: number; utilidad_estimada: number;
    ptu_pagada: number; perdidas_pendientes: number; base_gravable: number; tasa_isr: number;
    isr_causado: number; pagos_provisionales_previos: number; isr_retenido: number; isr_a_pagar: number;
  };
  iva: { iva_trasladado: number; iva_acreditable: number; iva_retenido: number; iva_a_cargo: number; iva_a_favor: number };
  total_a_pagar: number;
  nota: string;
}

@Injectable({ providedIn: 'root' })
export class ImpuestosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/impuestos`;

  provisional(p: ProvisionalParams): Observable<ProvisionalResult> {
    const q = new URLSearchParams({ period: p.period, cu: String(p.cu) });
    if (p.tasa != null) q.set('tasa', String(p.tasa));
    if (p.ptu != null) q.set('ptu', String(p.ptu));
    if (p.perdidas != null) q.set('perdidas', String(p.perdidas));
    if (p.pagos_previos != null) q.set('pagos_previos', String(p.pagos_previos));
    if (p.retenido != null) q.set('retenido', String(p.retenido));
    return this.http.get<ProvisionalResult>(`${this.base}/provisional?${q.toString()}`);
  }
}
