import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Arqueo ciego de caja (proyecto Tienda). Pega a `/store/arqueo` — la variante
 * acotada para cajeras del arqueo del Supervisor de Movimientos.
 *
 * El backend recorta en los dos ejes y ESTE service no puede aflojarlos:
 *  - **filas**: solo las sucursales asignadas al usuario (`ScopeService`, ADR-050);
 *  - **campos**: a la cajera no le llegan `esperado` ni `diff_real` (ni los
 *    `kepler_*`). Por eso ambos son opcionales acá: `undefined` = "no te toca
 *    verlo", y la UI esconde la columna en vez de pintar un cero mentiroso.
 *    Solo `RECONCILIATION_VER` (supervisor) los recibe.
 */
/**
 * SM.36 - `rd` y `rv` son la entrega del VENDEDOR DE RUTA en la tienda, no la
 * caja de mostrador: no cuelgan de un turno de Kepler y no tienen esperado.
 */
export type ArqueoTipo = 'cierre' | 'relevo' | 'retiro' | 'rd' | 'rv';

/** Una ruta dada de alta en la sucursal del usuario. */
export interface RutaArqueo {
  route_code: string;
  label: string;
  zona: string | null;
  tipo: 'rd' | 'rv';
}

export interface RutasResp { warehouse_code: string; rd: RutaArqueo[]; rv: RutaArqueo[] }

/** Lo que devuelve el arqueo de ruta. Sin diferencia, y lo dice.  */
export interface ArqueoRutaResult {
  tipo: ArqueoTipo; total_contado: number;
  route_code: string; route_label: string;
  medible: false; motivo_no_medible: string;
}

/**
 * Un turno de caja que Kepler abrió a nombre del usuario. Es lo que habilita la
 * captura: sin turno no hay arqueo. **No trae montos** — dice qué contar, no
 * cuánto debería haber.
 */
export interface Turno {
  warehouse_code: string;
  warehouse_name: string | null;
  caja: string;
  folio: string;
  business_date: string;
  hora_apertura: string | null;
  hora_cierre: string | null;
  cajero_code: string | null;
  turno: string | null;
  abierto: boolean;
  /** Minutos desde que Kepler cerró el turno. `null` = sigue abierto. */
  cerrado_hace_min?: number | null;
  /**
   * SM.17 — a qué hora suele cortar ESA caja, sacado del histórico. Solo llega
   * mientras el turno está abierto. `corte_iqr_min` es la dispersión: si es
   * grande el pronóstico no sirve y no se muestra.
   */
  corte_tipico?: string | null;
  corte_en_min?: number | null;
  corte_iqr_min?: number | null;
  /**
   * SM.35 — Qué TOCA hacer con este turno, resuelto en el backend.
   *
   * Son banderas, no montos: el arqueo es ciego y la cajera no puede ver cuánto
   * debería haber antes de contar. `cash_limit` sí llega (es la política de su
   * caja, que ya conoce, y no dice qué hay en el cajón); los montos que
   * sustentan las banderas solo viajan para el supervisor (`revela`).
   */
  cash_limit?: number | null;
  /** La caja pasó su límite (Kepler `c46`): toca sangría. */
  pide_retiro?: boolean;
  /** Kepler registró sangrías que nadie contó — sin esto el cierre no cuadra. */
  retiro_sin_contar?: boolean;
  /** Toca el corte del turno: parcial por naturaleza, y el que cierra. */
  pide_cierre?: boolean;
  cajon_estimado?: number | null;
  retirado_kepler?: number | null;
  retiros_contados?: number | null;
  retiro_sin_contar_monto?: number | null;
}

/** SM.38 - Una caja abierta de esta persona. */
export interface CajaAbierta {
  warehouse_code: string;
  caja: string;
  folio: string;
  business_date: string;
  hora_apertura: string | null;
  dias_abierta: number;
}

/**
 * SM.38 - El veredicto del candado de doble caja. `null` = puede operar.
 * `arrastradas` son cajas abiertas de dias anteriores: NO bloquean, se avisan.
 */
export interface BloqueoDobleCaja {
  cajas: CajaAbierta[];
  arrastradas: CajaAbierta[];
}

/** El bloqueo viaja CON la lista: pedirlo aparte dejaria la pantalla sin aviso si falla. */
export interface TurnosResp {
  turnos: Turno[];
  bloqueo: BloqueoDobleCaja | null;
}

export interface ArqueoDto {
  warehouse_code?: string; // ignorado si el usuario está scopeado a una sucursal
  /** Folio del turno de Kepler. Obligatorio para la cajera: la caja y la fecha salen de ahí. */
  cash_cut_folio?: string;
  caja: string;
  business_date: string; // 'YYYY-MM-DD'
  tipo?: ArqueoTipo;
  /** Solo rd/rv: la ruta que entrega. */
  route_code?: string;
  cajero_code?: string;
  cajero_entrante?: string;
  denominations: Record<string, number>;
  /** SM.24 — lo declarado en tarjeta, transferencia, retiros, créditos y cheques. */
  medios?: Record<string, number>;
  nota?: string;
  incidencia_tipo?: string; // SM.9: motivo cualitativo del descuadre (opcional)
}

export interface ArqueoResult {
  tipo: ArqueoTipo;
  total_contado: number;
  /** ¿El backend reveló la comparación? false para la cajera. */
  reveal: boolean;
  matched?: boolean;
  ambiguous?: boolean; // varios cortes en la caja/día y no se especificó cajero → no se comparó
  folio?: string;
  esperado?: number | null;
  diff_real?: number | null; // + faltante / − sobrante
  kepler_contado?: number | null; kepler_diff?: number | null; kepler_enmascaro?: boolean;
  /** SM.18 — el desglose grueso de Kepler, para imprimir el ticket completo al vuelo. */
  kepler_billetes?: number | null; kepler_monedas?: number | null; kepler_retirado?: number | null;
  /** Cada medio contra su columna. `cuadra: null` = Kepler no tiene con qué comparar. */
  medios?: { medio: string; declarado: number; kepler: number | null; diff: number | null; cuadra: boolean | null }[] | null;
}

export interface ArqueoRow {
  id: string; tipo: ArqueoTipo; warehouse_code: string; caja: string; business_date: string; turno: string | null;
  cajero_code: string | null; cajero_entrante: string | null; cajero_nombre: string | null; total_contado: number;
  captured_by: string | null; captured_at: string; nota: string | null; incidencia_tipo: string | null;
  cash_cut_folio?: string | null; caja_kepler?: string | null; turno_abierto_at?: string | null;
  /** `validado_at` nulo = pendiente de que la encargada lo firme presencialmente. */
  validado_por?: string | null; validado_at?: string | null; validado_nota?: string | null;
  /**
   * Los tres números de la validación, solo para quien valida:
   *   `esperado`        — lo que Kepler dice que debería haber
   *   `kepler_contado`  — lo que Kepler declara que se contó (casi siempre == esperado)
   *   `total_contado`   — nuestro conteo ciego: **el que vale**
   * `kepler_enmascaro` = Kepler dio el corte por cuadrado y el conteo real dice otra cosa.
   */
  esperado?: number | null; kepler_contado?: number | null; kepler_diff?: number | null;
  kepler_enmascaro?: boolean; diff_real?: number | null;
  /**
   * SM.18 — el desglose que Kepler SÍ manda (billetes/monedas, no por denominación)
   * y el nuestro partido igual, para poder compararlos. `kepler_desglose_cuadra`
   * verifica la identidad `billetes + monedas + retirado = contado`; cuando falla,
   * `kepler_desglose_faltante` suele ser un retiro que nadie registró.
   */
  kepler_billetes?: number | null; kepler_monedas?: number | null; kepler_retirado?: number | null;
  kepler_desglose_cuadra?: boolean | null; kepler_desglose_faltante?: number | null;
  nuestro_billetes?: number; nuestro_monedas?: number;
  /** El conteo pieza por pieza. Kepler no lo tiene: existe porque la cajera lo capturó. */
  denominaciones?: { key?: string; denominacion: number; cantidad: number; subtotal: number; familia?: 'billete' | 'moneda'; label?: string }[];
}

/**
 * Acumulado por cajera. Los campos de diferencia solo llegan a quien valida —
 * el agregado también revela: un `faltante_total` sobre un único arqueo ES la
 * diferencia de ese arqueo.
 */
export interface ArqueoPorCajera {
  cajero_code: string | null; cajero_nombre: string | null; warehouse_code: string;
  arqueos: number; total_contado: number; sin_validar: number; ultima_fecha: string | null;
  con_diferencia?: number; faltante_total?: number; sobrante_total?: number;
}

export interface ArqueoHistorial {
  arqueos: ArqueoRow[];
  por_cajera: ArqueoPorCajera[];
  totales: { arqueos: number; sin_validar: number; faltante_total?: number; sobrante_total?: number };
}

/** Un corte de Kepler con el arqueo nuestro colgado (si existe). */
export interface TurnoCorte {
  arqueo_id: string | null;
  business_date: string; caja: string; folio: string;
  hora_apertura: string | null; hora_cierre: string | null; duracion_horas: number | null;
  handoff?: boolean;
  esperado?: number | null;
  kepler_contado?: number | null; kepler_billetes?: number | null;
  kepler_monedas?: number | null; kepler_retirado?: number | null; venta?: number | null;
  /** `null` = el turno cerró en Kepler y nadie contó el efectivo. */
  nuestro_contado: number | null;
  diff_real?: number | null;
  /**
   * SM.39 - lleva `familia` porque el ticket la NECESITA: el billete y la moneda de $20
   * valen lo mismo y solo la familia los distingue. Es obligatoria y no opcional porque el
   * backend la saca del CATALOGO de denominaciones (`desglosar()` mapea DENOMINACIONES_MXN),
   * no de lo capturado: nunca puede faltar. Sin ella, el ticket parte billetes y monedas
   * comparando `>= 20`, que es justo el bug que SM.39 arreglo.
   */
  denominaciones: { key?: string; denominacion: number; cantidad: number; subtotal: number; familia: 'billete' | 'moneda'; label?: string }[];
  capturado_por: string | null; capturado_at: string | null;
  validado_por: string | null; validado_at: string | null;
  /** SM.22 — lo que el ticket necesita para ser el arqueo COMPLETO y no un resumen. */
  turno?: string | null; nota?: string | null; incidencia_tipo?: string | null; validado_nota?: string | null;
  kepler_tarjeta?: number | null; kepler_transfer?: number | null;
}

/** Una cajera con todos sus cortes del período. */
/** SM.21 — Cumplimiento del arqueo por sucursal. Solo lo ve quien supervisa. */
export interface CumplimientoSuc {
  warehouse_code: string; warehouse_name: string | null;
  cortes: number; arqueados: number; pct: number;
  pendientes: number; no_verificables: number;
  mediana_min: number | null; monto_sin_verificar: number;
}
export interface CumplimientoResp {
  sucursales: CumplimientoSuc[];
  totales: { cortes: number; arqueados: number; pct: number; pendientes: number; no_verificables: number; monto_sin_verificar: number };
  sla_min: number; critico_min: number;
}

export interface CajeraCard {
  cajero_code: string; cajero_nombre: string | null;
  warehouse_code: string; warehouse_name: string | null;
  cortes: number; dias: number; sin_arqueo: number; sin_validar?: number;
  faltante_total?: number; sobrante_total?: number; venta_total?: number;
  ultimo: string | null;
  turnos: TurnoCorte[];
}

export interface PorCajeraResp {
  cajeras: CajeraCard[];
  totales: { cajeras: number; cortes: number; sin_arqueo: number; faltante_total?: number };
}

@Injectable({ providedIn: 'root' })
export class ArqueoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/arqueo`;

  /** Turnos que Kepler abrió a nombre del usuario y todavía no arqueó. */
  turnos(dias?: number): Observable<TurnosResp> {
    return this.http.get<TurnosResp>(`${this.base}/turnos${dias ? '?dias=' + dias : ''}`);
  }

  /**
   * SM.36 - Las rutas dadas de alta en MI sucursal, partidas en RD y RV.
   * Devolver listas vacias es respuesta valida: hay tiendas sin rutas.
   */
  rutas(): Observable<RutasResp> {
    return this.http.get<RutasResp>(`${this.base}/rutas`);
  }

  /**
   * SM.36 - El arqueo de la entrega del vendedor de ruta. Endpoint APARTE del
   * de caja porque su permiso es otro: aca solo entran encargada y auxiliar.
   */
  /**
   * SM.36 - La entrega de una ruta NO manda `caja`: no hay caja que entregar. El backend la
   * pone el mismo (`caja: tipo.toUpperCase()` = RD/RV, la estacion) y la identidad la da
   * `route_code`. Por eso el DTO de acá afloja ese campo en vez de obligar al llamador a
   * inventarse un valor que el servidor va a pisar igual.
   */
  submitRuta(dto: Omit<ArqueoDto, 'caja'> & { caja?: string }): Observable<ArqueoRutaResult> {
    return this.http.post<ArqueoRutaResult>(`${this.base}/ruta`, dto);
  }

  submit(dto: ArqueoDto): Observable<ArqueoResult> {
    return this.http.post<ArqueoResult>(this.base, dto);
  }

  /** Historial con el acumulado por cajera. */
  historial(q?: { from?: string; to?: string; cajero?: string; sin_validar?: boolean; limit?: number }): Observable<ArqueoHistorial> {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.cajero) p.set('cajero', q.cajero);
    if (q?.sin_validar) p.set('sin_validar', 'true');
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<ArqueoHistorial>(`${this.base}/historial${qs ? '?' + qs : ''}`);
  }

  /** Tarjetas por cajera: sus cortes de Kepler + el arqueo nuestro cuando existe. */
  cumplimiento(q?: { from?: string }): Observable<CumplimientoResp> {
    const qs = q?.from ? `?from=${encodeURIComponent(q.from)}` : '';
    return this.http.get<CumplimientoResp>(`${this.base}/cumplimiento${qs}`);
  }

  porCajera(q?: { from?: string; to?: string; cajero?: string; limit?: number }): Observable<PorCajeraResp> {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.cajero) p.set('cajero', q.cajero);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<PorCajeraResp>(`${this.base}/por-cajera${qs ? '?' + qs : ''}`);
  }

  /** La encargada firma el arqueo tras contarlo en el lugar. */
  validar(id: string, nota?: string): Observable<unknown> {
    return this.http.post(`${this.base}/${id}/validar`, { nota });
  }

  list(q?: { from?: string; to?: string; limit?: number; warehouse_codes?: string[] }): Observable<ArqueoRow[]> {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.limit) p.set('limit', String(q.limit));
    // Filtro opcional DENTRO del alcance: el backend lo intersecta, pedir de más no suma.
    if (q?.warehouse_codes?.length) p.set('warehouse_codes', q.warehouse_codes.join(','));
    const qs = p.toString();
    return this.http.get<ArqueoRow[]>(`${this.base}${qs ? '?' + qs : ''}`);
  }
}
