import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[CE.5]` — Costo estándar de Kepler por producto.
 *
 * Sólo lectura sobre `analytics.v_kepler_standard_cost`. Este servicio **no calcula nada**:
 * ni desviaciones ni veredictos ni el cuadre del precio. Todo eso lo emite el servidor, que es
 * quien puede distinguir "no cuadra" de "no se pudo medir" — un cálculo en el cliente sobre
 * campos que pueden llegar NULL produce `NaN` y lo pinta como si fuera un número (ADR-056).
 */

export type VeredictoCostoEstandar =
  | 'al_dia'
  | 'estandar_bajo'
  | 'estandar_alto'
  | 'no_comparable'
  | 'testigo_inverosimil'
  | 'sin_testigo'
  | 'sin_operacion'
  | 'sin_estandar';

export interface FilaCostoEstandar {
  sucursal: string;
  sku: string;
  nombre: string | null;
  unidad_base: string | null;
  unidad_dos: string | null;
  unidad_tres: string | null;
  factor_dos: number | null;
  factor_tres: number | null;
  costo_estandar: number | null;
  costo_estandar_u2: number | null;
  costo_estandar_u3: number | null;
  margen_ficha_pct: number | null;
  precio_ficha: number | null;
  impuesto_pct: number | null;
  impuesto_renglones: number | null;
  impuesto_tasas_distintas: number | null;
  precio_reconstruido: number | null;
  precio_cuadra: boolean | null;
  precio_cuadra_motivo: string | null;
  costo_reposicion: number | null;
  peldano_reposicion: string | null;
  costo_reposicion_base: number | null;
  ultimo_costo: number | null;
  ultimo_costo_al: string | null;
  desviacion_pct: number | null;
  desviacion_por_unidad: number | null;
  veredicto: VeredictoCostoEstandar;
  unidades_base_30d: number | null;
  venta_bruta_30d: number | null;
  venta_neta_30d: number | null;
  impacto_cogs_30d: number | null;
  es_plaza_operativa: boolean;
  /** Salida **A**: capturar el costo nuevo MUEVE EL PRECIO (medido: 74 % de 6,501 cambios). */
  precio_si_conserva_margen: number | null;
  /** Salida **B**: el margen que de verdad se saca hoy, contra el costo real. */
  margen_real_pct: number | null;
  /** `margen_real_pct < 0`: pierde dinero en cada venta HOY. */
  vende_bajo_costo: boolean | null;
  /**
   * `[CE.11]` Qué movimiento dejó el costo del ERP donde está.
   *
   * ⛔ **Tres estados, no dos, y el tipo tiene que decirlo.** Estaban declarados `| null` a secas,
   * y eso hace que TypeScript AFIRME que el campo siempre viaja. No viaja: la migración
   * `20260930150000_standard_cost_con_origen` es la que agrega estas columnas a la vista y
   * **medido hoy contra la base, no está aplicada** — o sea que hoy llegan `undefined`, no `null`.
   *
   *  · `undefined` → la vista NO tiene la columna: **no se midió**. Lo arregla Sistemas.
   *  · `null`      → se midió y ningún movimiento casó (24.7 %): **no se pudo atribuir**.
   *  · valor       → se atribuyó.
   *
   * Con `| null` a secas las dos ausencias se leen igual y la pantalla publica la segunda
   * explicación —que es una MEDICIÓN— cuando lo cierto es la primera (ADR-056). Es el mismo
   * defecto que `FRESHNESS_UNKNOWN` con `stale:false` en VP.0: un tipo que no admite "no sé".
   */
  origen_familia?: 'compra' | 'inventario_fisico' | 'traspaso_u_otro' | 'otro' | null;
  origen_doctype?: string | null;
  origen_nombre?: string | null;
  origen_nombre_ambiguo?: boolean | null;
  origen_fecha_txt?: string | null;
  origen_folio?: string | null;
  origen_precio?: number | null;
  origen_cantidad?: number | null;
  origen_unidad?: string | null;
  /** `[CE.12]` el almacén que lo dejó, el folio como lo numera Kepler, y el tamaño del papel. */
  origen_almacen?: string | null;
  origen_doc_id?: string | null;
  origen_doc_renglones?: number | null;
  origen_doc_total?: number | null;
}

export interface ResumenCostoEstandar {
  reparto: { veredicto: VeredictoCostoEstandar; filas: number; impacto_cogs_30d: number | null }[];
  cobertura: {
    filas_totales: number;
    filas_con_operacion: number;
    filas_comparables: number;
    filas_sin_valorar: number;
    pct_comparable: number | null;
  };
  dinero: { cogs_subdeclarado_30d: number; cogs_sobredeclarado_30d: number; neto_30d: number };
  bajo_costo: { fichas: number; venta_30d: number; peor_margen_pct: number | null };
  oficinas_excluidas: number;
  precio: {
    filas_evaluadas: number;
    cuadran: number;
    no_cuadran: number;
    no_medibles: number;
    pct_cuadra: number | null;
  };
  actividad_al: string | null;
}

export interface ListadoCostoEstandar {
  filas: FilaCostoEstandar[];
  total: number;
}

export interface ConsultaCostoEstandar {
  sucursal?: string;
  veredicto?: VeredictoCostoEstandar | '';
  q?: string;
  incluir_sin_operacion?: boolean;
  incluir_oficinas?: boolean;
  solo_bajo_costo?: boolean;
  limite?: number;
  desplazamiento?: number;
}

@Injectable({ providedIn: 'root' })
export class CostoEstandarService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/standard-cost`;

  /**
   * `[CE.9]` Toma **los mismos** `sucursal` + `q` que `listar()`. Si el tablero no recibe el
   * texto del buscador, sus conteos dejan de describir la tabla que tiene debajo.
   */
  resumen(sucursal?: string, q?: string): Observable<ResumenCostoEstandar> {
    let p = new HttpParams();
    if (sucursal) p = p.set('sucursal', sucursal);
    if (q?.trim()) p = p.set('q', q.trim());
    return this.http.get<ResumenCostoEstandar>(`${this.base}/resumen`, { params: p });
  }

  listar(q: ConsultaCostoEstandar = {}): Observable<ListadoCostoEstandar> {
    let p = new HttpParams();
    if (q.sucursal) p = p.set('sucursal', q.sucursal);
    if (q.veredicto) p = p.set('veredicto', q.veredicto);
    if (q.q?.trim()) p = p.set('q', q.q.trim());
    if (q.incluir_sin_operacion) p = p.set('incluir_sin_operacion', 'true');
    if (q.incluir_oficinas) p = p.set('incluir_oficinas', 'true');
    if (q.solo_bajo_costo) p = p.set('solo_bajo_costo', 'true');
    if (q.limite) p = p.set('limite', String(q.limite));
    if (q.desplazamiento) p = p.set('desplazamiento', String(q.desplazamiento));
    return this.http.get<ListadoCostoEstandar>(this.base, { params: p });
  }

  /** El mismo SKU en todas las plazas: ahí se ve el costo estándar que difiere entre sucursales. */
  porSku(sku: string): Observable<FilaCostoEstandar[]> {
    return this.http.get<FilaCostoEstandar[]>(`${this.base}/${encodeURIComponent(sku)}`);
  }

  /**
   * `[CAT-COSTO.4]` Productos con costo estándar distinto según la sucursal. Quién se sale y
   * contra qué lo decide el servidor; la pantalla sólo pinta.
   */
  entreSucursales(q: ConsultaEntreSucursales = {}): Observable<RespuestaEntreSucursales> {
    let p = new HttpParams();
    if (q.q?.trim()) p = p.set('q', q.q.trim());
    if (q.proveedor_id) p = p.set('proveedor_id', q.proveedor_id);
    if (q.sucursal) p = p.set('sucursal', q.sucursal);
    if (q.veredicto) p = p.set('veredicto', q.veredicto);
    if (q.solo_diferencias === false) p = p.set('solo_diferencias', 'false');
    if (q.solo_con_venta) p = p.set('solo_con_venta', 'true');
    if (q.limite) p = p.set('limite', String(q.limite));
    if (q.desplazamiento) p = p.set('desplazamiento', String(q.desplazamiento));
    return this.http.get<RespuestaEntreSucursales>(`${this.base}/entre-sucursales`, { params: p });
  }
}

export type VeredictoEntreSucursales = 'distinto' | 'sin_mayoria' | 'unidad_distinta' | 'igual' | 'una_plaza';

export interface CeldaEntreSucursales {
  sucursal: string;
  costo: number;
  unidad: string | null;
  vende: boolean;
  comparada: boolean;
  /** `null` cuando no hay mayoría contra qué medir. */
  fuera: boolean | null;
  desviacion_pct: number | null;
}

export interface FilaEntreSucursales {
  sku: string;
  nombre: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  venta_30d: number;
  veredicto: VeredictoEntreSucursales;
  mayoria: number | null;
  diferencia_pct: number | null;
  sucursales_fuera: string[];
  celdas: CeldaEntreSucursales[];
}

export interface RespuestaEntreSucursales {
  sucursales: { codigo: string; nombre: string | null }[];
  resumen: Record<VeredictoEntreSucursales, number>;
  proveedores: { id: string; nombre: string; productos: number }[];
  tolerancia_pct: number;
  actividad_al: string | null;
  total: number;
  filas: FilaEntreSucursales[];
}

export interface ConsultaEntreSucursales {
  q?: string;
  proveedor_id?: string;
  sucursal?: string;
  veredicto?: VeredictoEntreSucursales | '';
  solo_diferencias?: boolean;
  solo_con_venta?: boolean;
  limite?: number;
  desplazamiento?: number;
}
