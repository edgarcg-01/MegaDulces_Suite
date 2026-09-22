import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * CG.13/CG.17 — Cliente del libro de caja (ADR-070).
 *
 * Distinto de `caja.service.ts` (CG.1-CG.7), que lee el ESPEJO del Access `Control`. Éste
 * habla con el lado que ESCRIBE: la plataforma como fuente principal del efectivo.
 */

export type TipoMovimiento = 'ingreso' | 'gasto' | 'deposito';

export interface ConceptoKepler {
  sucursal: string;
  cuenta: string;
  concepto: string;
  concepto_nombre: string;
  cuenta_mayor: string;
}

export interface MovimientoCaja {
  id: string;
  folio: string;
  tipo: TipoMovimiento;
  fecha: string;
  hora: string | null;
  sucursal: string;
  centro_costo: string | null;
  kepler_cuenta: string;
  kepler_concepto: string;
  kepler_cuenta_nombre: string | null;
  kepler_concepto_nombre: string | null;
  glosa: string;
  beneficiario: string | null;
  monto: number;
  morralla: number;
  origen_tipo: string | null;
  origen_ref: string | null;
  estado: string;
  created_by_username: string | null;
  created_at: string;
  /** Procedencia de lo que autorrellenó el motor. Ausente = lo tecleó una persona. */
  autofill: Record<string, unknown> | null;
}

export interface LibroResponse {
  rows: MovimientoCaja[];
  kpi: { movimientos: number; ingresos: number; gastos: number; depositos: number };
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CoberturaResponse {
  catalogo: Array<{ sucursal: string; filas_origen: number; usables: number; sin_subcuenta: number; sin_codigo: number; sin_nombre: number }>;
  mapa: Array<{ source_caja: string; cuentas: number; con_propuesta: number; sin_propuesta: number; confirmadas: number; por_confirmar: number }>;
}

export interface Propuesta<T = unknown> {
  value: T | null;
  source: string | null;
  confidence: number | null;
  support?: number;
  supportRatio?: number;
  reason?: string;
}

export interface AutofillResponse {
  concepto: Propuesta<{ kepler_cuenta: string; kepler_concepto: string }>;
  documento: Propuesta<Record<string, unknown>>;
  provenance: Record<string, unknown>;
  /** Un nivel `sin_fuente` NO es "no propuso": es que no se pudo consultar. */
  niveles: Record<string, 'consultado' | 'sin_fuente'>;
}

@Injectable({ providedIn: 'root' })
export class CashLedgerService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/finance/cash-ledger`;

  libro(f: { from?: string; to?: string; tipo?: string; sucursal?: string; cuenta?: string; search?: string; limit?: number; offset?: number }): Observable<LibroResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<LibroResponse>(this.base, { params: p });
  }

  conceptos(sucursal?: string, search?: string, limit = 50): Observable<{ rows: ConceptoKepler[]; limit: number }> {
    let p = new HttpParams().set('limit', String(limit));
    if (sucursal) p = p.set('sucursal', sucursal);
    if (search) p = p.set('search', search);
    return this.http.get<{ rows: ConceptoKepler[]; limit: number }>(`${this.base}/conceptos`, { params: p });
  }

  cobertura(): Observable<CoberturaResponse> {
    return this.http.get<CoberturaResponse>(`${this.base}/cobertura`);
  }

  /** PROPONE. No guarda nada. Lo que no puede proponer vuelve en null con su motivo. */
  autofill(input: { tipo?: string; sucursal?: string; glosa?: string; beneficiario?: string; beneficiario_rfc?: string; legacy_cuenta?: string }): Observable<AutofillResponse> {
    return this.http.post<AutofillResponse>(`${this.base}/autofill`, input);
  }

  crear(body: Record<string, unknown>): Observable<MovimientoCaja> {
    return this.http.post<MovimientoCaja>(this.base, body);
  }

  /**
   * CG.19 Capa 1 — **Los cobros que Kepler ya registró y todavía no se aplicaron.**
   *
   * El capturista ELIGE de acá en vez de teclear monto, fecha y motivo: el valor se toma del ERP
   * y el registro precede al dinero. Lo que NO está en esta lista no deja de existir — es el
   * ingreso que sigue capturándose a mano (~40-45% del total, medido), y por eso la pantalla
   * conserva el camino manual en vez de obligar a elegir.
   */
  movimientosPendientes(
    f: { tipo?: string; caja?: string; sucursal?: string; from?: string; to?: string; search?: string; limit?: number } = {},
  ): Observable<PendientesResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<PendientesResponse>(`${this.base}/movimientos-pendientes`, { params: p });
  }

  /**
   * CG.21 — Las cajas de efectivo del catálogo de Kepler, con su volumen medido.
   *
   * Viene del catálogo y no de los movimientos: una caja dormida tiene que poder verse en el
   * selector, o sería indistinguible de una que no existe.
   */
  cajas(dias?: number): Observable<{ rows: CajaKepler[]; ventana_dias: number }> {
    let p = new HttpParams();
    if (dias) p = p.set('dias', String(dias));
    return this.http.get<{ rows: CajaKepler[]; ventana_dias: number }>(`${this.base}/cajas`, { params: p });
  }

  /**
   * CG.20/CG.21 — **Confirma N movimientos de un golpe.** El backend corre cada fila en su propia
   * transacción: una que falle NO tumba a las demás, y el resultado viene por fila.
   */
  confirmarLote(items: Array<{ origen_ref: string; monto_contado?: number }>): Observable<ResumenLote> {
    return this.http.post<ResumenLote>(`${this.base}/lote`, {
      // El `client_uuid` va por fila: si la red corta y la persona reintenta, el reintento
      // devuelve lo que ya se guardó en vez de duplicarlo.
      items: items.map((i) => ({ ...i, client_uuid: crypto.randomUUID() })),
    });
  }

  /** CG.20 — Los pares que ese capturista más repite, para ofrecerlos de un toque. */
  frecuentes(f: { tipo?: string; sucursal?: string; limit?: number } = {}): Observable<{ rows: Frecuente[]; medido: { pares_con_soporte: number; minimo_usos: number } }> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<{ rows: Frecuente[]; medido: { pares_con_soporte: number; minimo_usos: number } }>(
      `${this.base}/frecuentes`, { params: p });
  }

  detalle(id: string): Observable<MovimientoCaja & { denominaciones: Array<{ denominacion: number; piezas: number }>; arqueo: { desglosado: number; diferencia: number } | null }> {
    return this.http.get<any>(`${this.base}/${id}`);
  }

  // ── CG.15 · corte, saldo y cancelación ───────────────────────────────────────────────

  /** `saldo: null` + `sin_corte_abierto` NO es cero: la caja no tiene punto de partida. */
  saldo(sucursal: string): Observable<SaldoResponse> {
    return this.http.get<SaldoResponse>(`${this.base}/saldo/${encodeURIComponent(sucursal)}`);
  }

  cortes(f: { from?: string; to?: string; sucursal?: string; estado?: string; limit?: number } = {}): Observable<{ rows: CorteCaja[]; limit: number }> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<{ rows: CorteCaja[]; limit: number }>(`${this.base}/cortes`, { params: p });
  }

  abrirCorte(body: { fecha: string; sucursal: string; fondo_inicial?: number; nota?: string }): Observable<CorteCaja> {
    return this.http.post<CorteCaja>(`${this.base}/cortes`, body);
  }

  /**
   * CG.19 — SELLA el conteo y recién entonces revela. Era `previa`, que mostraba la diferencia
   * mientras se contaba: con eso el arqueo era una transcripción del esperado.
   */
  contarCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla = 0): Observable<RevelacionCorte> {
    return this.http.post<RevelacionCorte>(`${this.base}/cortes/${id}/contar`, { conteo, morralla });
  }

  /** Segundo y ÚLTIMO conteo. El motivo es obligatorio y el primero se conserva. */
  recontarCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla: number, motivo: string): Observable<RevelacionCorte> {
    return this.http.post<RevelacionCorte>(`${this.base}/cortes/${id}/recontar`, { conteo, morralla, motivo });
  }

  cerrarCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla = 0, nota?: string): Observable<CorteCaja & { totales: TotalesCorte }> {
    return this.http.post<CorteCaja & { totales: TotalesCorte }>(`${this.base}/cortes/${id}/cerrar`, { conteo, morralla, nota });
  }

  /** Devuelve 403 si lo intenta quien cerró: la doble llave está en la DB, no acá. */
  autorizarCorte(id: string): Observable<CorteCaja> {
    return this.http.post<CorteCaja>(`${this.base}/cortes/${id}/autorizar`, {});
  }

  cancelar(id: string, motivo: string): Observable<MovimientoCaja> {
    return this.http.post<MovimientoCaja>(`${this.base}/${id}/cancelar`, { motivo });
  }
}

export interface CorteCaja {
  id: string;
  folio: string;
  fecha: string;
  sucursal: string;
  estado: 'borrador' | 'cerrado' | 'autorizado';
  fondo_inicial: number;
  total_ingresos: number | null;
  total_gastos: number | null;
  total_depositos: number | null;
  esperado: number | null;
  contado: number | null;
  diferencia: number | null;
  closed_by: string | null;
  closed_by_username: string | null;
  authorized_by_username: string | null;
  nota: string | null;
}

export interface TotalesCorte {
  ingresos: number; gastos: number; depositos: number;
  /**
   * ⛔ CG.19 — **opcionales a propósito.** El servidor los recorta para quien no autoriza: el
   * arqueo es CIEGO. `diferencia` y `veredicto` se van JUNTO con `esperado` porque
   * `esperado = contado − diferencia` y el veredicto es su signo — publicar uno es publicar los
   * tres. Cuando faltan, viene `oculto: true`.
   */
  esperado?: number; diferencia?: number;
  veredicto?: 'cuadra' | 'sobra' | 'falta' | 'sin_contar';
  contado: number;
  movimientos: number; cancelados: number;
  /** De qué está hecho el esperado: cuánto del ingreso viene de Kepler y cuánto de un teclado. */
  ingresos_anclados: number; ingresos_capturados: number;
  /** 0..1, o `null` si no hubo ingresos. NUNCA 0 por falta de datos. */
  cobertura_ingreso: number | null;
  /** El servidor DICE que recortó, en vez de mandar campos ausentes sin explicación. */
  oculto?: true;
  /** Viaja aunque sea ciego: no revela nada y la pantalla necesita saber si ya se contó. */
  conto?: boolean;
}

/**
 * Un movimiento de caja que Kepler ya registró y el libro todavía no aplicó. Los DOS signos.
 *
 * `origen_ref` es su identidad: **`sucursal|doc_tipo|folio|clave_banco`**. El `doc_tipo` no es
 * decorativo — medido, el folio COLISIONA entre `X-A-45`, `X-D-26` y `X-D-60` (los folios
 * 0000011, 0000029, 0000030… existen en los tres a la vez), así que sin él confirmar un anticipo
 * bloquearía un pago distinto.
 */
export interface MovimientoPendiente {
  origen_ref: string;
  /** `ingreso` | `gasto`, derivado del signo del documento en el ERP. */
  tipo: string;
  origen_tipo: string;
  /** Clave de la caja en el catálogo `kdb1`. `0011` = CAJA GENERAL. */
  clave_banco: string;
  caja_nombre: string | null;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  fecha_valor: string;
  /** El código de la contraparte en Kepler (`CB013`, `GG015`, `RD 21`, `2-32-321`). */
  entidad_code: string | null;
  beneficiario: string | null;
  concepto: string | null;
  metodo: string | null;
  monto: number;
  /**
   * CG.20/CG.21 — `true` = se puede confirmar sin elegir NADA (la cuenta contable ya viene
   * resuelta: del mapa declarado si es ingreso, de una regla si es egreso). `false` viene SIEMPRE
   * con `motivo_texto`: sin el porqué, la pantalla tendría que adivinar, y adivinar acá es
   * inventar una cuenta contable.
   */
  confirmable: boolean;
  kepler_cuenta: string | null;
  kepler_concepto: string | null;
  motivo?: 'sin_mapa' | 'sin_confirmar' | 'sin_cuenta' | 'sin_monto' | 'sin_regla';
  motivo_texto?: string;
}

/** Una caja de efectivo del catálogo `kdb1`, con lo que de verdad se movió por ella. */
export interface CajaKepler {
  clave: string;
  nombre: string;
  cuenta_contable: string | null;
  /** Documentos en la ventana. `0` acá es un HECHO medido, no una falta de datos. */
  documentos: number;
}

export interface PendientesResponse {
  /** Desde qué fecha se está mirando. `ventana_dias` null = el filtro lo puso la persona. */
  desde?: string;
  ventana_dias?: number | null;
  /**
   * Lo que la ventana DEJA FUERA, declarado. Medido en prod al aplicar CG.21: con el libro nuevo
   * vacío, "pendiente" era todo lo que Kepler registró desde 2025 — 12,160 movimientos. Eso no es
   * trabajo del día, es una decisión de hasta dónde se migra lo que el Access ya registró; pero
   * tampoco puede desaparecer de la pantalla.
   */
  fuera_de_ventana?: { movimientos: number; monto: number };
  rows: MovimientoPendiente[];
  limit: number;
  has_more: boolean;
  /** Cuántas de las visibles se pueden confirmar de un clic. Una lista llena de filas trabadas
   *  no puede leerse igual que una lista lista (ADR-056). */
  confirmables: number;
}

/** Resultado del lote: por fila, porque una que falla no tumba a las demás. */
export interface ResumenLote {
  filas: Array<{ origen_ref: string; estado: 'guardado' | 'duplicado' | 'rechazado' | 'no_confirmable'; folio?: string; motivo?: string }>;
  guardados: number;
  duplicados: number;
  rechazados: number;
  no_confirmables: number;
  /** Suma SÓLO lo guardado. Un total optimista es una mentira. */
  monto_guardado: number;
}

/** Un par (cuenta, concepto, beneficiario) que esa persona repite. Un toque lo llena. */
export interface Frecuente {
  kepler_cuenta: string;
  kepler_concepto: string;
  glosa: string | null;
  beneficiario: string | null;
  usos: number;
  ultimo_uso: string | null;
  rango: number;
}

/** Lo que devuelve sellar el conteo: acá SÍ viene revelado — ya no se puede retocar en silencio. */
export interface RevelacionCorte {
  corte_id: string;
  totales: TotalesCorte;
  puede_recontar: boolean;
  sellado_por?: string;
  conteo_previo_contado?: number;
}

export interface SaldoResponse {
  sucursal: string;
  corte_abierto: { id: string; folio: string; fondo_inicial: number; ya_reconto: boolean } | null;
  saldo: number | null;
  /** `saldo` es el esperado con otro nombre: cuando está oculto se declara, no se confunde con 0. */
  saldo_oculto: boolean;
  sin_corte_abierto: boolean;
  movimientos_sueltos: number;
  totales: TotalesCorte;
}
