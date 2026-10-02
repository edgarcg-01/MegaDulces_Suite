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
  a1_costo_hoy: string | null; a2_costo_ficha: string | null;
  a6_deriva_costo_pct: string | null;
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
  /** ⚠️ Sin `& Record<string, unknown>`: el index signature impide el acceso por punto
   *  en el template y obliga a escribir `d['campo']`, que es ilegible. */
  accion: ColaRow;
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

/** `[PR.X1]` Un mes de la serie de costo, precio y volumen. */
export interface MesHistoria {
  mes: string;
  costo_unitario: string | null; precio_unitario: string | null; margen_pct: string | null;
  unidades_total: string | null; venta_total: string | null;
  dias_con_venta: number; cobertura_costo_pct: string | null; venta_sin_costo: string | null;
}

/** `[PR.X2]` Un cambio de precio real, ya limpio de centinelas y de ida y vuelta. */
export interface EventoPrecio {
  fecha: string; unidad_base: string; precio_antes: string; precio_despues: string;
  cambio_pct: string; es_alza: boolean;
  unidades_en_evento: number; spread_pct: string | null; veredicto_unidad: string;
}

/**
 * `[PR.X2]` Qué pasó la vez anterior. ⭐⭐ `lr_pre` es el PLACEBO y viaja en la misma fila:
 * si no es ~0, las dos ventanas no eran comparables y `lr_post` NO se puede leer como efecto.
 */
export interface RespuestaPrecio {
  fecha: string; unit_kind: string | null;
  precio_antes: string; precio_despues: string; cambio_pct: string; es_alza: boolean;
  vol_pre: string; vol_post: string; dias_pre: number; dias_post: number;
  lr_post: string | null; lr_pre: string | null; veredicto: string; motivo: string | null;
}

/** El mismo SKU en otra plaza. */
export interface PlazaRow {
  sucursal: string; precio_actual: string | null;
  a1_costo_hoy: string | null; a2_costo_ficha: string | null;
  margen_realizado_pct: string | null; meta_margen_pct: string | null;
  accion: string; certeza: string; venta_30d: string | null;
  e3_estado_inventario: string | null; g2_clase_abc: string | null; es_esta: boolean;
}

/** `[PR.X3]` ⛔ Cada fila trae su atraso: Wincaja dejó de registrar al migrar la plaza. */
export interface PerdidaRow {
  mes: string; sucursal: string;
  unidades_perdidas: string; importe_perdido: string;
  reportes: number; clientes: number;
  dias_de_atraso: number; motivo_atraso: string | null;
}

export interface Expediente extends DetalleMotor {
  historia: MesHistoria[];
  eventos: EventoPrecio[];
  respuesta: RespuestaPrecio[];
  plazas: PlazaRow[];
  perdida: PerdidaRow[];
}

/** `[PR.X3]` El simulador. Todo aritmética; `no_sabe` dice qué NO responde. */
export interface Simulacion {
  precio_actual: string | null; precio_nuevo: number; cambio_pct: number | null;
  costo: string | null; costo_fuente: string | null;
  margen_nuevo_pct: number | null; margen_meta_pct: string | null;
  margen_realizado_pct: string | null;
  umbral_equilibrio_pct: string | null; umbral_percepcion_pct: string | null;
  se_percibe: boolean | null;
  aterrizajes: { p99: string | null; p00: string | null; p90: string | null };
  no_sabe: string;
  error?: string;
}

// ── `[PR.M3]`+`[PR.M6]` La competencia ───────────────────────────────────────

/** Una marca contra el resto del canal. `competencia` es NULL cuando no se puede calcular. */
export interface CompetenciaFabricante {
  fabricante: string;
  nuestro: string | null; mercado: string | null;
  competencia: string | null; competencia_delta: string | null;
  share_pct: string | null;
}

export interface CompetenciaAusente {
  fabricante: string; submarca: string;
  division: string; categoria: string;
  competencia: string | null;
}

/**
 * El precio IMPLICITO de la competencia.
 *
 * ⛔ `confianza` NO es decoración: sale de **nuestro** share en volumen, que es donde está el
 * ruido. Medido, con share ≥10 % la desviación es 0.17 y por debajo sube a 0.71. Una fila con
 * `confianza: 'baja'` se lee distinto que una con `'alta'`, y la pantalla tiene que mostrarlo.
 */
export interface CompetenciaPrecio {
  fabricante: string; submarca: string; categoria: string;
  precio_nuestro: string | null; precio_competencia: string | null;
  dif_pct: string | null; share_volumen_pct: string | null;
  confianza: 'alta' | 'baja' | null;
  venta_nuestra: string | null;
}

export interface CompetenciaMotor {
  medido: boolean;
  motivo?: string;
  periodo?: string;
  universo?: { region: string; subcanal: string; mercado: string; medida: string };
  total?: {
    nuestro: string | null; mercado: string | null; competencia: string | null;
    marcas: number; marcas_no_medibles: number;
  };
  por_veredicto?: { veredicto: string; marcas: number; nuestro: string | null; competencia: string | null }[];
  fabricantes?: CompetenciaFabricante[];
  ausentes?: CompetenciaAusente[];
  precio?: {
    resumen: { veredicto: string; confianza: string | null; submarcas: number; venta_nuestra: string | null }[];
    mas_caras_que_el_mercado: CompetenciaPrecio[];
    mas_baratas_que_el_mercado: CompetenciaPrecio[];
    declara: string[];
  };
  declara?: string[];
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

  /** ⭐ Un solo viaje: cinco llamadas serían cinco estados de carga en la misma ventana. */
  expediente(sucursal: string, sku: string): Observable<Expediente> {
    return this.http.get<Expediente>(
      `${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(sku)}/expediente`);
  }

  /**
   * `[PR.M3]`+`[PR.M6]` — La competencia: cuánto vende por marca, y a qué precio.
   *
   * ⚠️ `subcanal` no es un filtro cosmético: **cambia la cifra y las dos son ciertas**. En
   * `Mayoreo Puro` —nuestro canal— el share es 5.36 %; en el mayoreo total, 3.80 %. La
   * diferencia son $426.8M de mercado en subcanales donde no vendemos nada.
   */
  competencia(f: { subcanal?: string; region?: string; mercado?: string; limit?: number } = {}): Observable<CompetenciaMotor> {
    const p = new URLSearchParams();
    if (f.subcanal) p.set('subcanal', f.subcanal);
    if (f.region) p.set('region', f.region);
    if (f.mercado) p.set('mercado', f.mercado);
    if (f.limit) p.set('limit', String(f.limit));
    const qs = p.toString();
    return this.http.get<CompetenciaMotor>(`${this.base}/competencia${qs ? `?${qs}` : ''}`);
  }

  simular(sucursal: string, sku: string, precio: number): Observable<Simulacion> {
    return this.http.get<Simulacion>(
      `${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(sku)}/simular`
      + `?precio=${encodeURIComponent(String(precio))}`);
  }
}
