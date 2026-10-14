import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Freshness } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** CS.2 — Cliente del reporte de CAOS (`/finance/caos`). */

export interface CaosMovimiento {
  id: string;
  device: string;
  external_id: number;
  type_id: number;
  type_label: string;
  occurred_at: string;
  accounting_date: string | null;
  user_external: string | null;
  total: number;
  currency: string;
  ref: string | null;
  shift_id: string | null;
}

export interface CaosKpi {
  movimientos: number;
  depositos: number;
  dispensado: number;
  balance: number;
  datos_al: string | null;
}

export interface CaosMovimientosResponse {
  rows: CaosMovimiento[];
  kpi: CaosKpi;
  desde: string;
  limit: number;
  has_more: boolean;
}

export interface CaosDenominacion { denom: number; pieza_tipo: string; quantity: number }

export interface CaosDetalle extends CaosMovimiento {
  cheques: unknown[];
  tickets: unknown[];
  denominaciones: CaosDenominacion[];
}

@Injectable({ providedIn: 'root' })
export class CaosService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/finance/caos`;

  movimientos(f: { from?: string; to?: string; tipo?: string; usuario?: string; ref?: string; limit?: number }): Observable<CaosMovimientosResponse> {
    let p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosMovimientosResponse>(`${this.base}/movimientos`, { params: p });
  }

  detalle(id: string): Observable<CaosDetalle> {
    return this.http.get<CaosDetalle>(`${this.base}/movimientos/${id}`);
  }

  /**
   * [CG.58.7] La liga de la ruta con su dinero. La consume el panel de
   * /comercial/ventas-por-ruta, gateada con COMMERCIAL_ROUTE_SALES_VER (no con el permiso de
   * CAOS): la mitad de los roles que abren esa pantalla no lo tienen.
   */
  rutaCaja(from?: string, to?: string): Observable<RutaCajaReporte> {
    const p: Record<string, string> = {};
    if (from) p['from'] = from;
    if (to) p['to'] = to;
    return this.http.get<RutaCajaReporte>(`${this.base}/por-ruta`, { params: p });
  }

  resumen(f: { from?: string; to?: string }): Observable<CaosResumen> {
    let p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosResumen>(`${this.base}/resumen`, { params: p });
  }

  conciliacion(f: { from?: string; to?: string }): Observable<CaosConciliacion> {
    let p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosConciliacion>(`${this.base}/conciliacion`, { params: p });
  }

  /** `[CG.58]` Cuánto del efectivo de la caja fuerte está atado a cobros de Kepler. Sólo lee. */
  ingresosEstado(f: { from?: string; to?: string } = {}): Observable<CaosIngresosEstado> {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosIngresosEstado>(`${this.base}/ingresos/estado`, { params: p });
  }

  /**
   * ⛔ **No hay cliente para `POST ingresos/conciliar` a propósito.** Lo dispara el carril
   * automático (`CaosIngresoCronService`, cada hora) llamando al servicio directo, no por HTTP.
   * El endpoint sigue existiendo para operación, pero la pantalla no lo ofrece: un botón que
   * alguien tiene que acordarse de apretar es de donde veníamos — la tabla llevaba meses en cero.
   */
}

/**
 * `[CG.58]` Los TRES cubos van separados a propósito (ADR-056): «sin respaldo» (un depósito que
 * ningún cobro anterior explica) y «sin depositar» (cobro que todavía no entró al equipo) son
 * cosas distintas y las arregla gente distinta. Sumarlos borraría esa diferencia.
 */
export interface CaosIngresosEstado {
  desde: string;
  depositos: number;
  monto_depositado: number;
  conciliados: number;
  monto_conciliado: number;
  pendientes: number;
  monto_pendiente: number;
  /** Efectivo cobrado que todavía no entró al equipo. */
  monto_sin_depositar: number;
  /**
   * `[CG.58.5]` Cuándo corrió solo por última vez. **`null` = nunca**, y se declara: una
   * automatización que no se ve se lee igual que una que no existe.
   */
  latido: { cuando: string; status: string; nota: string | null; error: string | null } | null;
}


export interface CaosCuadreDia { dia: string; caos_dep: number; kepler_ing: number; caos_dis: number; kepler_egr: number }
export interface CaosConciliacion {
  dias: CaosCuadreDia[];
  totales: { caos_dep: number; kepler_ing: number; caos_dis: number; kepler_egr: number };
  cobertura: { depositos: number | null; dispensado: number | null };
  desde: string; hasta: string;
}

export interface CaosPorRuta { ruta: string | null; movimientos: number; total: number }
export interface CaosPorOperador {
  user_external: string | null;
  depositos_n: number; depositos_total: number;
  dispensado_n: number; dispensado_total: number;
}
export interface CaosResumen { porRuta: CaosPorRuta[]; porOperador: CaosPorOperador[]; desde: string }

/**
 * [CG.58.7] — La liga que consume /comercial/ventas-por-ruta: deposito de CAOS -> entrada a
 * Caja General, agrupado por la ruta que DECLARA el texto del deposito.
 *
 * ⚠️ El nombre no es CaosPorRuta: esa interfaz ya existe en este archivo y es otra cosa (el
 * resumen CS.6, que agrupa movimientos por el ref sin cruzar nada contra Caja General).
 */
export type RutaCajaGrano = 'ruta_dia' | 'ruta' | 'plaza' | 'sin_declarar';

export interface RutaCajaDeposito {
  /** A que fila pertenece. La manda el servidor: la pantalla NO re-deduce la precedencia. */
  clave: string;
  device: string;
  external_id: number;
  occurred_at: string;
  monto_caos: number;
  ref: string | null;
  grano: RutaCajaGrano;
  vecinal: boolean;
  ruta: string | null;
  plaza: string | null;
  fecha_venta: string | null;
  motivo: string;
  cg_folio: string | null;
  cg_fecha: string | null;
  cg_monto: number | null;
  cg_estado: string | null;
  cg_sucursal: string | null;
  cg_entradas: number;
  delta: number | null;
}

export interface RutaCajaFila {
  clave: string;
  etiqueta: string;
  grano: RutaCajaGrano;
  vecinal: boolean;
  ruta: string | null;
  plaza: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  sucursales: string[];
  motivo_sucursal: string | null;
  depositos: number;
  monto_caos: number;
  en_caja_general: number;
  monto_caja_general: number;
  pendientes: number;
  monto_pendiente: number;
}

export interface RutaCajaReporte {
  from: string;
  to: string;
  filas: RutaCajaFila[];
  depositos: RutaCajaDeposito[];
  resumen: {
    depositos: number; monto: number;
    en_caja_general: number; monto_caja_general: number;
    pendientes: number; monto_pendiente: number;
    vecinal: number; monto_vecinal: number;
    plaza: number; monto_plaza: number;
    sin_declarar: number; monto_sin_declarar: number;
  };
  datos_al: string | null;
  /** [VP.2.3] Frescura canónica del espejo de CAOS (la manda el servidor; ver `CaosPorRuta`). */
  freshness: Freshness;
  generated_at: string;
}
