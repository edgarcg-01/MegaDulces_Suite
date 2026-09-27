import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[FLT.6]` Lista de faltantes — cliente HTTP de `commercial/floor-stockouts`.
 *
 * A diferencia del verificador, acá **no hay modo sin red**: reportar es ESCRIBIR, y una escritura
 * que se guarda sólo en el navegador de una caja es un dato que nadie va a ver nunca. Si falla la
 * red, la pantalla lo dice y deja reintentar; no finge que se guardó.
 */

export type StockoutKind =
  | 'agotado'
  | 'no_en_anaquel'
  | 'no_en_sucursal'
  | 'no_en_catalogo'
  | 'codigo_no_pasa';
export type StockoutStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type StockoutDecision =
  | 'alta_catalogo' | 'ya_en_camino' | 'no_se_trabaja' | 'codigo_corregido' | 'era_error';

export interface ReportarPayload {
  warehouse_code: string;
  kind: StockoutKind;
  scanned_code?: string;
  sku?: string;
  product_name?: string;
  source?: 'verificador' | 'almacen' | 'caja' | 'otro';
}

export interface ReportarResultado {
  id: string;
  kind: StockoutKind;
  /** A quién le toca. Lo deriva el servidor de (motivo, existencia) — acá sólo se rotula. */
  destino: StockoutDestino;
  times_reported: number;
  product_name: string | null;
  on_hand_at_report: number | null;
  est_lost_revenue: number | null;
  est_source: 'precio_erp' | 'sin_dato';
  /** Dijo "no hay" y el ERP dice que sí. Es un descuadre de inventario, no un aviso de compra. */
  contradice_al_erp: boolean;
}

export interface Faltante extends ReportarResultado {
  sku: string | null;
  scanned_code: string | null;
  week_start: string;
  first_reported_at: string | null;
  last_reported_at: string;
  status: StockoutStatus;
  decision: StockoutDecision | null;
  decision_note: string | null;
  decided_by_username: string | null;
  reported_by_username: string | null;
  source: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
}

export interface CodigoQueFalla {
  sku: string | null;
  scanned_code: string | null;
  product_name: string | null;
  veces: number;
  ultima_vez: string;
}

export interface ResumenFaltantes {
  abiertos: number;
  /** Cuántos de los abiertos NO se pudieron valorar. Se muestra aparte: el total no es completo. */
  abiertos_sin_valorar: number;
  dinero_estimado: number;
  no_en_catalogo: number;
  contradicen_al_erp: number;
  /** `[FLT.21]` Lo que se recupera HOY: hay existencia y no estaba en el anaquel. */
  recuperable_hoy: number;
  dinero_recuperable_hoy: number;
}

/** Etiquetas en llano. El motivo es lo que la persona del mostrador elige, así que se lee como habla. */
export interface MotivoUi {
  kind: StockoutKind;
  label: string;
  ayuda: string;
  icon: string;
}

export const MOTIVOS: ReadonlyArray<MotivoUi> = [
  // `[FLT.21]` El motivo nuevo va PRIMERO: es el único cuya venta todavía no se perdió.
  { kind: 'no_en_anaquel', label: 'No estaba en el anaquel', ayuda: 'Sí hay en la tienda — avisar a piso', icon: 'pi pi-box' },
  { kind: 'agotado', label: 'No hay en la tienda', ayuda: 'Busqué y no está en ningún lado', icon: 'pi pi-inbox' },
  { kind: 'no_en_sucursal', label: 'No se maneja aquí', ayuda: 'Existe, pero no en esta tienda', icon: 'pi pi-map-marker' },
  { kind: 'no_en_catalogo', label: 'No lo trabajamos', ayuda: 'No está en el catálogo', icon: 'pi pi-question-circle' },
  { kind: 'codigo_no_pasa', label: 'El código no pasó', ayuda: 'Existe, pero el lector no lo tomó', icon: 'pi pi-ban' },
];

/** `[FLT.21]` A quién le toca. Lo deriva el servidor; acá sólo se rotula. */
export type StockoutDestino = 'piso' | 'compras' | 'inventario' | 'catalogo';

export const ETIQUETA_DESTINO: Record<StockoutDestino, string> = {
  piso: 'Piso — surtir anaquel',
  compras: 'Compras',
  inventario: 'Inventario — descuadre',
  catalogo: 'Catálogo — código',
};

/** `[FLT.22]` Lo que contesta «¿lo tenemos?» antes de pedir nada. */
export interface ConsultaFaltante {
  encontrado: boolean;
  termino: string;
  warehouse_code: string;
  warehouse_name: string | null;
  sku?: string;
  product_name?: string;
  precio?: number | null;
  /** `null` = NO SE PUDO MEDIR. Nunca 0 por defecto. */
  existencia?: number | null;
  veredicto?: 'hay_en_tienda' | 'sin_existencia' | 'no_medido';
}

export const ETIQUETA_MOTIVO: Record<StockoutKind, string> =
  MOTIVOS.reduce((a, m) => ({ ...a, [m.kind]: m.label }), {} as Record<StockoutKind, string>);

export const ETIQUETA_DECISION: Record<StockoutDecision, string> = {
  alta_catalogo: 'Se da de alta',
  ya_en_camino: 'Ya viene en camino',
  no_se_trabaja: 'No se trabaja',
  codigo_corregido: 'Código corregido',
  era_error: 'No era faltante',
};

@Injectable({ providedIn: 'root' })
export class FaltantesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/floor-stockouts`;

  reportar(payload: ReportarPayload): Observable<ReportarResultado> {
    return this.http.post<ReportarResultado>(this.base, payload);
  }

  porSucursal(code: string, semanas = 4): Observable<Faltante[]> {
    return this.http.get<Faltante[]>(`${this.base}/sucursal/${encodeURIComponent(code)}`, {
      params: { semanas: String(semanas) },
    });
  }

  /**
   * `[FLT.22]` «¿Lo tenemos?» — resuelve el producto y contesta la existencia ANTES de reportar.
   * Es lo que hace que la pantalla le sirva a quien la abre, y no sólo a Compras tres días después.
   */
  consultar(code: string, termino: string): Observable<ConsultaFaltante> {
    return this.http.get<ConsultaFaltante>(
      `${this.base}/sucursal/${encodeURIComponent(code)}/consulta`,
      { params: { q: termino } },
    );
  }

  codigosQueFallan(code: string): Observable<CodigoQueFalla[]> {
    return this.http.get<CodigoQueFalla[]>(
      `${this.base}/sucursal/${encodeURIComponent(code)}/codigos-que-fallan`,
    );
  }

  // ── Compras ───────────────────────────────────────────────────────────────────────────────

  bandeja(filtros: { status?: string; kind?: string; warehouse_code?: string } = {}): Observable<Faltante[]> {
    const params: Record<string, string> = {};
    if (filtros.status) params['status'] = filtros.status;
    if (filtros.kind) params['kind'] = filtros.kind;
    if (filtros.warehouse_code) params['warehouse_code'] = filtros.warehouse_code;
    return this.http.get<Faltante[]>(this.base, { params });
  }

  resumen(): Observable<ResumenFaltantes> {
    return this.http.get<ResumenFaltantes>(`${this.base}/resumen`);
  }

  decidir(id: string, decision: StockoutDecision, nota?: string) {
    return this.http.patch<{ id: string; status: StockoutStatus; decision: StockoutDecision }>(
      `${this.base}/${id}/decision`, { decision, nota },
    );
  }
}
