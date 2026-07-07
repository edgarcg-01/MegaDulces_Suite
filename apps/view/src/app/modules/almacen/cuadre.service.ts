import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** SM.1 — cliente de la bandeja de descuadres del Supervisor de Movimientos. */

export type DiscPlano = 'inventario' | 'caja' | 'cruce';
export type DiscSeverity = 'info' | 'warn' | 'critical';
export type DiscStatus = 'nuevo' | 'en_revision' | 'confirmado' | 'descartado' | 'corregido';
export type DiscVerdict = 'util' | 'falso' | 'duplicado' | 'ya_corregido';

export interface Discrepancy {
  id: string;
  rule_key: string;
  regla: string | null;
  plano: DiscPlano;
  severity: DiscSeverity;
  status: DiscStatus;
  score: number | null;
  titulo: string;
  resumen: string;
  entity: Record<string, any> | null;
  periodo: string | null;
  esperado: number | null;
  observado: number | null;
  diferencia: number | null;
  importe: number;
  causa_probable: string | null;
  causa_confirmada: string | null;
  evidencia: Record<string, any> | null;
  first_seen: string;
  last_seen: string;
}

export interface DiscStats {
  pendientes: number;
  criticos: number;
  monto_en_juego: number;
  por_plano: { plano: DiscPlano; n: number; monto: number }[];
}

export interface RuleHealth {
  rule_key: string;
  nombre: string;
  plano: DiscPlano;
  enabled: boolean;
  pinned: boolean;
  suppressed_auto: boolean;
  precision_score: number | null;
  findings_total: number;
  findings_confirmados: number;
  findings_falsos: number;
}

export interface CuadreOverview {
  caja: { cortes: number; con_descuadre: number; faltante: number; sobrante: number; venta: number };
  inventario: { mermas: number; monto_merma: number };
  descuadres: { pendientes: number; criticos: number };
  top_cajeros: { sucursal: string; cajero: string; eventos: number; faltante: number }[];
  por_sucursal: { sucursal: string; cortes: number; faltante_caja: number; merma: number }[];
}

export interface CashCut {
  id: string; warehouse_code: string; warehouse_name: string | null; caja: string; folio: string;
  business_date: string; cajero_cierre: string | null; turno: string | null;
  efectivo_esperado: number; efectivo_contado: number; efectivo_diff: number;
  tarjeta_esperado: number; transfer_esperado: number; total_venta: number;
}

export interface StockMovement {
  id: string; warehouse_code: string; almacen: string | null; sku: string; clase_mov: string;
  grupo: string | null; folio: string; unidad: string | null; unidades: number; importe: number; fecha: string;
}

@Injectable({ providedIn: 'root' })
export class CuadreService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/reconciliation`;

  list(q?: { status?: string; plano?: string; severity?: string; rule_key?: string; limit?: number }): Observable<Discrepancy[]> {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.plano) p.set('plano', q.plano);
    if (q?.severity) p.set('severity', q.severity);
    if (q?.rule_key) p.set('rule_key', q.rule_key);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<Discrepancy[]>(`${this.base}/discrepancies${qs ? '?' + qs : ''}`);
  }

  stats(): Observable<DiscStats> { return this.http.get<DiscStats>(`${this.base}/discrepancies/stats`); }
  rules(): Observable<RuleHealth[]> { return this.http.get<RuleHealth[]>(`${this.base}/rules`); }

  setStatus(id: string, status: DiscStatus): Observable<any> {
    return this.http.patch(`${this.base}/discrepancies/${id}/status`, { status });
  }
  feedback(id: string, verdict: DiscVerdict, causa?: string, nota?: string): Observable<any> {
    return this.http.post(`${this.base}/discrepancies/${id}/feedback`, { verdict, causa, nota });
  }
  pinRule(ruleKey: string, pinned: boolean): Observable<any> {
    return this.http.post(`${this.base}/rules/${ruleKey}/pin`, { pinned });
  }
  scan(): Observable<{ total_nuevos: number; nuevos_criticos: any[]; por_regla: any[] }> {
    return this.http.post<{ total_nuevos: number; nuevos_criticos: any[]; por_regla: any[] }>(`${this.base}/scan`, {});
  }

  overview(): Observable<CuadreOverview> { return this.http.get<CuadreOverview>(`${this.base}/overview`); }

  cashCuts(q?: { sucursal?: string; cajero?: string; from?: string; to?: string; min_diff?: number; solo_descuadres?: boolean; limit?: number }): Observable<CashCut[]> {
    const p = new URLSearchParams();
    if (q?.sucursal) p.set('sucursal', q.sucursal);
    if (q?.cajero) p.set('cajero', q.cajero);
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.min_diff != null) p.set('min_diff', String(q.min_diff));
    if (q?.solo_descuadres) p.set('solo_descuadres', 'true');
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<CashCut[]>(`${this.base}/cash-cuts${qs ? '?' + qs : ''}`);
  }

  movements(q?: { clase_mov?: string; sucursal?: string; sku?: string; from?: string; to?: string; limit?: number }): Observable<StockMovement[]> {
    const p = new URLSearchParams();
    if (q?.clase_mov) p.set('clase_mov', q.clase_mov);
    if (q?.sucursal) p.set('sucursal', q.sucursal);
    if (q?.sku) p.set('sku', q.sku);
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<StockMovement[]>(`${this.base}/movements${qs ? '?' + qs : ''}`);
  }
}
