import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * CC (extensión) — cliente de Comprobantes de Orden de Entrada (proyecto Compras).
 * Lista las órdenes de entrada de Kepler (X-A-40) y les adjunta la remisión/factura
 * del proveedor (**sólo PDF** desde 2026-08-27) con OCR. No escribe a Kepler. Backend en `libs/finance`
 * (las evidencias viven en el schema `finance`), ruta `/finance/goods-receipts`.
 */

export type ProofStatus = 'recibido' | 'validado' | 'rechazado';

export interface EntradaRow {
  sucursal: string;
  folio: string;
  receipt_date: string | null;
  proveedor_code: string | null;
  proveedor_nombre: string | null;
  proveedor_rfc: string | null;
  oc_folio: string | null;
  concepto: string | null;
  source_branch: string | null; // md_* = Kepler, wincaja_* = Wincaja (define el set de docs requeridos)
  monto: number;
  deposits: number;
  deposit_id: string | null;
  deposit_status: ProofStatus | null;
  monto_match: boolean;
  /** fecha capturada adelante de hoy: el renglón se ordena como si fuera de hoy y se marca */
  fecha_futura: boolean;
  // RE.13.0 — los dos relojes del proceso + el veredicto de atraso ya resuelto por el server.
  /** días desde la recepción, acotados a hoy (una fecha futura cuenta 0, no negativo). */
  dias: number;
  /** días que la evidencia lleva esperando decisión (null si no hay evidencia). */
  dias_espera: number | null;
  /** pasó el SLA que le aplica: captura si no tiene evidencia, revisión si la tiene. */
  atrasada: boolean;
  /** |factura − entrada| de la última evidencia (null si no hay OCR con importe). */
  discrepancy_amount: number | null;
  // RE.13.2 — quién subió (segregación de funciones: el revisor no valida lo propio) y por
  // qué se devolvió (la sucursal lo necesita en su worklist).
  deposit_by: string | null;
  motivo_rechazo: string | null;
  motivo_codigo: string | null;
  // RE.14.3 — la MISMA recepción está capturada dos veces: en el Kepler de la sucursal y en el
  // de oficinas (9.95, sucursal '00'). `origen` dice de qué servidor salió esta fila; los
  // `gemela_*` describen la otra copia, cuando la hay.
  origen?: 'sucursal' | 'oficinas';
  /** folio con el que oficinas capturó la misma recepción (null si no está apareada). */
  gemela_folio: string | null;
  gemela_date: string | null;
  gemela_monto: number | null;
  /** oficinas − sucursal: la diferencia entre nuestras dos capturas, no con el proveedor. */
  gemela_delta: number | null;
  gemela_regla: string | null;
  gemela_score: number | null;
}

/** RE.14.3 — un par de la misma recepción capturada dos veces, con los dos lados a la vista. */
export interface TwinPair {
  cedis_folio: string;
  sucursal: string;
  folio: string;
  suc_date: string | null;
  cedis_date: string | null;
  suc_monto: number | null;
  cedis_monto: number | null;
  suc_prov: string | null;
  cedis_prov: string | null;
  delta_monto: number | null;
  delta_dias: number | null;
  match_rule: string | null;
  match_score: number | null;
  status: 'propuesto' | 'auto' | 'confirmado' | 'rechazado';
  decided_by: string | null;
  decided_at: string | null;
  // RE.17.3 — cuántos renglones tiene cada lado. Es la señal que decide de un vistazo: la copia
  // de sucursal lista productos (12–20) y la de oficinas suele traer uno de concepto.
  suc_lineas: number | null;
  cedis_lineas: number | null;
}

/** RE.17.3 — los renglones de un lado del par (los de Kepler, no los del OCR). */
export interface TwinSideLines {
  sucursal: string;
  folio: string;
  lineas: EntradaLinea[];
}

export interface TwinLines {
  sucursal: TwinSideLines;
  oficinas: TwinSideLines;
}

/** RE.14.6 — lo que encontró una corrida del motor de apareo. */
export interface TwinScanResult {
  nuevas: number;
  marcadas: number;
  propuestas: number;
  obsoletas: number;
  ms: number;
}

export interface TwinsReport {
  rows: TwinPair[];
  /** `monto_propuesto` = lo que hoy se cuenta dos veces por falta de dictamen. */
  kpis: { propuestos: number; vigentes: number; monto_propuesto: number };
  total: number;
  alcance?: EntradasAlcance;
}

/** RE.13.2 — una decisión en la cadena del expediente. */
export interface ProofHistoryEntry {
  status_from: string | null;
  status_to: string;
  motivo_codigo: string | null;
  motivo: string | null;
  changed_by: string | null;
  changed_at: string;
}

/** RE.13.0 — parámetros del proceso (los define el tenant, no el código). */
export interface ReceiptSettings {
  reception_start: string;
  match_tolerance: number;
  sla_capture_days: number;
  sla_review_days: number;
  bulk_max_files: number;
}

/** RE.13.0 — qué sucursales puede ver el usuario. `null` = todas (alcance `all`). */
export interface EntradasAlcance {
  sucursales: string[] | null;
  total_visibles: number | null;
}

/** RE.13.0 — filtros del listado. `warehouse_codes` es el nombre canónico ([ID.5]). */
export interface EntradasQuery {
  estado?: 'pendiente' | 'con_comprobante' | 'por_validar' | 'validado' | 'rechazado' | '';
  from?: string;
  to?: string;
  search?: string;
  warehouse_codes?: string[];
  dias_min?: number;
  carril?: 'al_dia' | 'rezago' | 'todo';
  orden?: 'antiguedad' | 'reciente' | 'monto' | 'riesgo';
  page?: number;
  pageSize?: number;
}

/** RE.16 — quién tiene permiso de subir en una sucursal. `propio` = su ficha la apunta ahí. */
export interface CoverageResponsable {
  username: string;
  nombre: string | null;
  alcance: 'propio' | 'asignado';
}

/** RE.13.4 — cobertura del proceso por sucursal (la tabla de "¿quién no está subiendo?"). */
export interface CoverageRow {
  sucursal: string;
  /**
   * RE.16 — quiénes pueden subir acá. Vacío NO es "nadie trabaja": es un permiso que falta,
   * y son dos conversaciones distintas. Sin esto el tablero acusa al inocente.
   */
  responsables: CoverageResponsable[];
  entradas: number;
  con_evidencia: number;
  validadas: number;
  por_validar: number;
  rechazadas: number;
  monto: number;
  monto_pendiente: number;
  atrasadas: number;
  /** antigüedad de lo PENDIENTE: el promedio esconde la cola larga, que es la que hay que perseguir */
  dias_p50: number;
  dias_p90: number;
  pct_evidencia: number;
  pct_validadas: number;
}

export interface CoverageReport {
  settings: ReceiptSettings;
  rows: CoverageRow[];
  /** Lo anterior al arranque, aparte: mezclarlo al % lo vuelve inservible para exigir. */
  rezago: { entradas: number; monto: number };
  /** RE.16 — cuántos ven/suben en la red entera. Aparte, o ninguna sucursal se ve huérfana. */
  responsables_red?: number;
}

/** Frescura de UNA fuente (rama Kepler o sucursal Wincaja) de la lista de entradas. */
export interface EntradaFrescura {
  source_branch: string;
  origen: 'kepler' | 'wincaja';
  ultima: string;
  dias: number;
  /** hueco mediano de esa fuente en 90 días — su cadencia normal */
  cadencia_dias: number;
  tolerancia_dias: number;
  atrasada: boolean;
}

export interface EntradasReport {
  kpis: {
    entradas: number; con_comprobante: number; validados: number; monto_pendiente: number;
    // RE.13.0 — lo que las vistas nuevas necesitan contar sin traerse las filas.
    por_validar: number; rechazados: number; atrasadas: number;
    /** SLA del REVISOR: evidencia esperando decisión más de lo permitido. */
    por_validar_atrasadas: number;
  };
  frescura: EntradaFrescura[];
  rows: EntradaRow[];
  /** total del universo filtrado: antes la lista cortaba en 300 sin decirlo. */
  total: number;
  page: number;
  pageSize: number;
  alcance: EntradasAlcance;
  settings: ReceiptSettings;
}

/** Un archivo ya subido a una entrada (o su duplicado) — para reportar dónde ya vive. */
export interface DuplicateHit { reason: 'file' | 'folio'; sucursal: string; folio: string; proveedor?: string | null; }

/** RE.11.0 — un renglón de producto extraído de la remisión (materia prima del match por línea). */
export interface RemisionLine {
  descripcion: string | null;
  cantidad: number | null;
  unidad: string | null;
  sku_proveedor: string | null;
  codigo_barras: string | null;
  precio_unitario: number | null;
  importe: number | null;
}

/** Campos que devuelve el OCR de la remisión/factura (preview antes de guardar). */
export interface RemisionOcr {
  folio: string | null;
  fecha: string | null;
  proveedor: string | null;
  rfc: string | null;
  subtotal: number | null;
  iva: number | null;
  total: number | null;
  ocr_status: string;
  sha256?: string;               // hash del contenido (anti-hoja-duplicada)
  duplicate?: DuplicateHit | null; // ya subida antes (misma hoja o folio)
  // RE (#4/pkt.1) — documentos detectados en el archivo, anclados a evidencia (página + prueba).
  documents_present?: DocPresence[];
  // RE.11.0 — renglones extraídos (para conciliación por línea).
  lines?: RemisionLine[];
}

/** RE.11.2 — un renglón conciliado: remisión ↔ línea Kepler ↔ SKU resuelto. */
export interface ReconciledLine {
  idx: number;
  remision: RemisionLine;
  kepler: { linea: string; sku: string | null; nombre: string | null; unidad: string | null; cantidad: number; costo_unitario: number; importe: number } | null;
  resolved_sku: string | null;
  resolved_nombre: string | null;
  method: 'alias' | 'barcode' | 'descripcion' | 'sin_match';
  score: number;
  box_factor: number;
  qty_remision_pz: number | null;
  qty_kepler: number | null;
  qty_match: boolean | null;
  price_match: boolean | null;
  status: 'cuadra' | 'difiere_cantidad' | 'difiere_precio' | 'revisar' | 'sin_match';
  alias_hit: boolean;
}

export interface ReconcileResult {
  sucursal: string;
  folio: string;
  proveedor_rfc: string | null;
  proveedor_nombre: string | null;
  lines: ReconciledLine[];
  kepler_orphans: { linea: string; sku: string | null; nombre: string | null; unidad: string | null; cantidad: number; costo_unitario: number; importe: number }[];
  totals: { lineas_remision: number; lineas_kepler: number; cuadran: number; difieren: number; sin_match: number; revisar: number; kepler_orphans: number };
}

/** RE.pkt.1 — un documento detectado dentro del paquete, con su página y prueba. */
export interface DocPresence {
  type: string;              // aplica_orden_entrada|factura|remision|ticket|orden_recepcion|vale|otro
  page: number | null;       // página 1-based (null si imagen suelta)
  evidence: string | null;   // folio/título/línea distintiva que lo identifica
}

export interface ProofFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string;
  sha256?: string; ocr_folio?: string | null; ocr_total?: number | null; ocr_fecha?: string | null; ocr_rfc?: string | null;
}

/** Línea de detalle de una orden de entrada (kdm2) para auditar renglón por renglón. */
export interface EntradaLinea {
  linea: string;
  sku: string | null;
  nombre: string | null;
  unidad: string | null;
  cantidad: number;
  costo_unitario: number;
  importe: number;
}

/** Una remisión/factura adjunta (archivos + OCR + estado) — devuelta por detail(). */
export interface ReceiptDeposit {
  id: string;
  files: ProofFile[];
  ocr_folio: string | null;
  ocr_fecha: string | null;
  ocr_proveedor: string | null;
  ocr_rfc: string | null;
  ocr_subtotal: number | null;
  ocr_iva: number | null;
  ocr_monto: number | null;
  ocr_status: string;
  ocr_lines?: RemisionLine[];        // RE.11.0 — renglones OCR persistidos (para conciliar)
  monto_match: boolean | null;
  discrepancy_kind: string | null;   // RE.2 — cuadra/iva/typo/otro (clasificación del descuadre)
  discrepancy_amount: number | null; // RE.2 — |factura − entrada|
  status: ProofStatus;
  comentarios: string | null;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface EntradaDetail {
  entrada: {
    sucursal: string; folio: string; receipt_date: string | null;
    proveedor_code: string | null; proveedor_nombre: string | null; proveedor_rfc: string | null;
    oc_folio: string | null; vale_folio: string | null; concepto: string | null; monto: number;
  };
  lineas: EntradaLinea[];
  deposits: ReceiptDeposit[];
  // RE.12/RE.14 — copia(s) de OFICINAS ('00') de esta misma recepción, con la regla del apareo y
  // su estado: `propuesto` todavía no cuenta como espejo (espera dictamen).
  cedis_twins?: {
    sucursal: string; folio: string; receipt_date: string | null;
    oc_folio: string | null; vale_folio: string | null; monto: number | null;
    delta_monto?: number | null; delta_dias?: number | null;
    match_rule?: string | null; match_score?: number | null;
    status?: 'propuesto' | 'auto' | 'confirmado' | 'rechazado';
    decided_by?: string | null; decided_at?: string | null;
  }[];
  /** RE.14.3 — se pidió por el folio de oficinas y el server resolvió a la canónica. */
  redirigido_de?: { sucursal: string; folio: string } | null;
  /** RE.13.2 — cadena de decisiones (quién subió, quién devolvió y por qué, quién validó). */
  history?: ProofHistoryEntry[];
}

export interface AttachReceipt {
  sucursal: string;
  folio: string;
  files: ProofFile[];
  ocr?: Partial<RemisionOcr>;
  comentarios?: string;
}

/** RE.13.3 — resultado del lote: por expediente, no un booleano. */
export interface AttachBulkResult {
  guardadas: number;
  omitidas: number;
  cuadran: number;
  detalle: { sucursal: string; folio: string; ok: boolean; monto_match?: boolean; motivo?: string }[];
}

@Injectable({ providedIn: 'root' })
export class EntradasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/goods-receipts`;

  list(q: EntradasQuery = {}): Observable<EntradasReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) {
      if (v == null || v === '') continue;
      // `warehouse_codes=01,03` — el backend acepta CSV o repetido; CSV mantiene la URL corta.
      params = params.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return this.http.get<EntradasReport>(this.base, { params });
  }
  /** RE.13.4 — cobertura por sucursal (respeta el alcance del usuario). */
  coverage(q: { from?: string; to?: string; warehouse_codes?: string[] } = {}): Observable<CoverageReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) {
      if (v == null || v === '') continue;
      params = params.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return this.http.get<CoverageReport>(`${this.base}/coverage`, { params });
  }
  /** Parámetros vigentes del proceso (arranque, tolerancia, SLA, tope de lote). */
  /**
   * RE.14.3 — pares de la misma recepción capturada dos veces. `estado='propuesto'` trae los que
   * esperan dictamen: mientras nadie decida, esa recepción se sigue contando dos veces.
   */
  twins(q: { estado?: 'propuesto' | 'vigente' | 'todos'; search?: string; limit?: number; warehouse_codes?: string[] } = {}): Observable<TwinsReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) {
      if (v == null || v === '') continue;
      params = params.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return this.http.get<TwinsReport>(`${this.base}/twins`, { params });
  }
  /**
   * RE.14.6 — corre el motor de apareo ahora. El cron ya lo hace cada 5 minutos; esto es para
   * cuando alguien está mirando la bandeja y quiere ver lo de este momento.
   */
  scanTwins(): Observable<TwinScanResult | null> {
    return this.http.post<TwinScanResult | null>(`${this.base}/twins/scan`, {});
  }
  /**
   * RE.17.3 — los renglones de los DOS lados del par. Se pide al expandir la fila y no con la
   * lista: son dos consultas contra el ODS por par, y la bandeja trae hasta 200.
   */
  twinLines(cedisFolio: string): Observable<TwinLines> {
    return this.http.get<TwinLines>(`${this.base}/twins/${encodeURIComponent(cedisFolio)}/lines`);
  }
  /** Dictamina el par: `confirmar` (es la misma recepción) o `rechazar` (es compra de oficinas). */
  decideTwin(cedisFolio: string, decision: 'confirmar' | 'rechazar'): Observable<{ cedis_folio: string; status: string }> {
    return this.http.post<{ cedis_folio: string; status: string }>(
      `${this.base}/twins/${encodeURIComponent(cedisFolio)}/decide`, { decision });
  }

  settings(): Observable<ReceiptSettings> {
    return this.http.get<ReceiptSettings>(`${this.base}/settings`);
  }
  /**
   * RE.16 — guarda los parámetros del proceso (pestaña Ajustes del Centro de control). Hasta
   * ahora sólo existía el GET: la fecha de arranque y el SLA se movían con un UPDATE a mano.
   */
  saveSettings(p: Partial<ReceiptSettings>): Observable<ReceiptSettings> {
    return this.http.put<ReceiptSettings>(`${this.base}/settings`, p);
  }
  /** Detalle de la entrada + sus líneas (kdm2) para auditar renglón por renglón. */
  detail(sucursal: string, folio: string): Observable<EntradaDetail> {
    return this.http.get<EntradaDetail>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}`);
  }
  /** Corre OCR sobre una hoja (data URI, **sólo PDF**) — preview, no guarda. Devuelve
   *  también el hash + si es duplicada (misma hoja o folio ya subido). `role` afina el dedup. */
  ocr(file_base64: string, role?: string): Observable<RemisionOcr> {
    return this.http.post<RemisionOcr>(`${this.base}/ocr`, { file_base64, role });
  }
  /** FOTO-PRIMERO: enlaza por OCR de la Aplica Orden Entrada (folio/total) o busca manual. */
  matchByOcr(q: { folio?: string; total?: number; fecha?: string; search?: string }): Observable<{ entradas: EntradaRow[] }> {
    let p = new HttpParams();
    if (q.folio) p = p.set('folio', q.folio);
    if (q.total != null) p = p.set('total', String(q.total));
    if (q.fecha) p = p.set('fecha', q.fecha);
    if (q.search) p = p.set('search', q.search);
    return this.http.get<{ entradas: EntradaRow[] }>(`${this.base}/match`, { params: p });
  }
  /** Sube la remisión (**sólo PDF**) al bucket privado y devuelve su referencia. */
  uploadFile(file_base64: string, role = 'remision'): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** Adjunta la evidencia a la entrada (archivos ya subidos + OCR). */
  attach(body: AttachReceipt): Observable<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean }> {
    return this.http.post<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean }>(`${this.base}/attach`, body);
  }
  /**
   * RE.13.3 — adjunta varios expedientes de una pasada (lote de CEDIS). Cada uno va en su
   * propia transacción del lado del server: un duplicado en el archivo 12 no tira los 11
   * anteriores, y la respuesta dice qué quedó afuera y por qué.
   */
  attachBulk(items: AttachReceipt[]): Observable<AttachBulkResult> {
    return this.http.post<AttachBulkResult>(`${this.base}/attach-bulk`, { items });
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string, motivo_codigo?: string): Observable<any> {
    return this.http.post(`${this.base}/${id}/reject`, { motivo, motivo_codigo });
  }
  /** RE.13.2 — valida varias; el server revalida cada id y dice qué omitió y por qué. */
  validateBulk(ids: string[]): Observable<{ validadas: number; omitidas: number; detalle: { id: string; ok: boolean; motivo?: string }[] }> {
    return this.http.post<{ validadas: number; omitidas: number; detalle: { id: string; ok: boolean; motivo?: string }[] }>(`${this.base}/validate-bulk`, { ids });
  }
  /** RE.11.2 — concilia los renglones de la remisión contra las líneas Kepler de la entrada. */
  reconcile(sucursal: string, folio: string, lines: RemisionLine[]): Observable<ReconcileResult> {
    return this.http.post<ReconcileResult>(`${this.base}/reconcile`, { sucursal, folio, lines });
  }
  /** RE.11.4 — aprende un match: descripción del proveedor → SKU interno. */
  confirmLine(body: { proveedor_rfc: string; descripcion: string; sku: string; nombre_interno?: string; unidad_proveedor?: string; box_factor?: number }): Observable<{ id: string; sku: string; veces_confirmado: number; confianza: number }> {
    return this.http.post<{ id: string; sku: string; veces_confirmado: number; confianza: number }>(`${this.base}/confirm-line`, body);
  }
}
