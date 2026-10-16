import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
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
}

export interface CaosKpi {
  movimientos: number;
  depositos: number;
  dispensado: number;
  /** Depósitos − dispensado. **No es el saldo de la máquina**: ver `otros_total`. */
  balance: number;
  /**
   * `[CG.163]` Movimientos del rango que NO son depósito ni dispensación (`Vaciar Stocks`,
   * `Dotar`, `Fin de Dia`, `Contenido Modificado`, `Cambio`). Van SEPARADOS porque su signo
   * contra el dispositivo no está decodificado: meterlos al balance sería inventar la cifra con
   * la que alguien va a cuadrar. Se declaran con su monto (ADR-056), no se esconden en cero.
   */
  otros_n: number;
  otros_total: number;
  datos_al: string | null;
}

/** `[CG.163]` Los tipos que de verdad existen en la ventana. El combo ya no los adivina. */
export interface CaosTipo { type_id: number; type_label: string; n: number }

export interface CaosMovimientosResponse {
  rows: CaosMovimiento[];
  kpi: CaosKpi;
  tipos: CaosTipo[];
  desde: string;
  limit: number;
  has_more: boolean;
}

export interface CaosDenominacion { denom: number; pieza_tipo: string; quantity: number }

export interface CaosDetalle extends CaosMovimiento {
  cheques: unknown[];
  tickets: unknown[];
  denominaciones: CaosDenominacion[];
  /**
   * `[CG.163]` Suma de `denom × quantity`. Se publica al lado de `total` porque **no siempre
   * coinciden**, y callarlo hace leer el drill como una comprobación que nadie hizo: medido en
   * prod, `Vaciar Stocks` ext. 1478 declara $20.00 y su desglose suma $86,220.
   */
  denominaciones_total: number;
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

/**
 * `[CG.163]` Ya no es «la ruta que una regex sacó del ref»: es el **grano** que
 * `finance.caos_deposito_grano` declara para cada depósito (`[CG.58.6]`). `motivo` viaja con la
 * fila para que la pantalla no tenga que deducir por qué quedó ahí — y es lo que separa la
 * VECINAL (otro circuito, se arquea en su caja) de «el texto no declara nada», que no son lo
 * mismo y las arregla gente distinta.
 */
export type CaosGrano = 'ruta_dia' | 'ruta' | 'plaza' | 'sin_declarar' | 'sin_clasificar';
export interface CaosPorRuta {
  grano: CaosGrano;
  ruta: string | null;
  plaza: string | null;
  motivo: string;
  movimientos: number;
  total: number;
}
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
  data_as_of: string | null;
  generated_at: string;
}
