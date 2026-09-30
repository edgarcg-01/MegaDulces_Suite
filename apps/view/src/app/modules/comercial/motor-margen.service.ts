import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** `[PR.V1]` Una acción del triage, con su certeza — que es lo que decide cómo se prioriza. */
export interface AccionResumen {
  accion: string;
  certeza: 'aritmetica' | 'efecto_no_medido' | 'regla_de_operacion' | 'fuera_de_alcance' | string;
  celdas: number;
  libres: number;
  flujo_libre: string | null;
  flujo_total: string | null;
  capital: string | null;
  venta_expuesta: string | null;
}

export interface BloqueoResumen { bloqueo: string; celdas: number; venta: string | null }

export interface ResumenMotor {
  acciones: AccionResumen[];
  sin_accion: { celdas: number; venta: string | null };
  total: { celdas: number; bloqueadas: number; calculado_al: string | null };
  bloqueos: BloqueoResumen[];
}

export interface ColaRow {
  sucursal: string; sku: string; nombre: string;
  precio_actual: string | null; venta_30d: string | null;
  accion: string; certeza: string;
  monto_en_juego_mxn: string | null; monto_motivo: string | null;
  capital_inmovilizado_mxn: string | null;
  bloqueos: string[]; accionable: boolean;
  s1_senal: string | null; s1_mxn: string | null;
  s2_senal: string | null; s2_mxn: string | null;
  s3_senal: string | null; s3_mxn: string | null;
  margen_realizado_pct: string | null; meta_margen_pct: string | null;
  dif_vs_meta_pp: string | null;
  d1_terminacion: string | null; d1_candidato_99: string | null;
  d1_alza_99_pct: string | null; d4_umbral_percepcion: string | null;
  e3_estado_inventario: string | null; g2_clase_abc: string | null;
  d8_prima_caja_pct: string | null;
  familias_con_evidencia: number; familias_totales: number;
  calculado_al: string | null;
}

/** Una familia de señales con su cobertura y su motivo. El motivo es parte del dato. */
export interface FamiliaSenal {
  n: number; nombre: string; senales: string[];
  veredicto: string | null; cobertura: string | null; motivo: string | null;
}

export interface DetalleMotor {
  accion: ColaRow & Record<string, unknown>;
  senales: Record<string, unknown> | null;
  familias: FamiliaSenal[];
}

/** El registro: lo que el motor lee y —sobre todo— lo que NO. */
export interface SenalRegistro {
  clave: string; familia: string; nombre: string; definicion: string;
  unidad: string; direccion: string; estado: string;
  cobertura_pct: string; cobertura_medida_al: string | null;
  fuente_columna: string | null; motivo_ausencia: string | null;
  peso_max: string; nucleo: boolean;
}

export interface RegistroSenales {
  senales: SenalRegistro[];
  conteo: { total: number; cableadas: number; disponibles: number; refutadas: number; no_existen: number };
}

@Injectable({ providedIn: 'root' })
export class MotorMargenService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/margin-engine`;

  resumen(): Observable<ResumenMotor> {
    return this.http.get<ResumenMotor>(`${this.base}/resumen`);
  }

  senales(): Observable<RegistroSenales> {
    return this.http.get<RegistroSenales>(`${this.base}/senales`);
  }

  cola(f: { sucursal?: string; accion?: string; soloLibres?: boolean; limit?: number } = {}): Observable<ColaRow[]> {
    const p = new URLSearchParams();
    if (f.sucursal) p.set('sucursal', f.sucursal);
    if (f.accion) p.set('accion', f.accion);
    if (f.soloLibres) p.set('solo_libres', 'true');
    if (f.limit) p.set('limit', String(f.limit));
    const qs = p.toString();
    return this.http.get<ColaRow[]>(`${this.base}/cola${qs ? `?${qs}` : ''}`);
  }

  detalle(sucursal: string, sku: string): Observable<DetalleMotor> {
    return this.http.get<DetalleMotor>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(sku)}`);
  }
}
