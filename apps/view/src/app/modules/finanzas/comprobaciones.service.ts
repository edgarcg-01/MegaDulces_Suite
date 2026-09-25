import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
// [GX.14] El catálogo de formas de pago y la compuerta NO se copian acá: se importan del
// contrato compartido, que es el mismo que valida el backend.
import type { FormaPagoId } from '@megadulces/contracts';

/** GX.7 — cliente de solicitudes de reembolso (captura multi-archivo + validación). */

export type ProofStatus = 'recibida' | 'aprobada' | 'validada' | 'rechazada' | 'revision';

/** Roles de archivo del formulario (Google Form → plataforma). */
export type ProofFileRole = 'comprobante_1' | 'comprobante_2' | 'solicitud_kepler' | 'evidencia_1' | 'evidencia_2' | 'evidencia_3';
export interface ProofFile {
  role: ProofFileRole | string; url: string; public_id?: string; kind?: string; name?: string;
  /** `[GX.14]` Salió de la cámara, no de un archivo. Ver el límite en `aporte-solicitante.contract.ts`. */
  live?: boolean;
  /** `[GX.14]` Cuándo se tomó (ISO). */
  captured_at?: string;
}

/** Naturaleza del gasto — decide si la evidencia (factura/ticket) es obligatoria. */
export type ExpenseClasificacion = 'fiscal' | 'no_fiscal_comprobable' | 'no_comprobable';
/** ¿Este gasto debe llevar evidencia adjunta? Todo salvo lo declarado no_comprobable. */
export function requiereEvidencia(c?: string | null): boolean {
  return c === 'fiscal' || c === 'no_fiscal_comprobable';
}
/** Etiquetas de la clasificación para la UI. */
export const CLASIFICACION_LABEL: Record<ExpenseClasificacion, string> = {
  fiscal: 'Con factura',
  no_fiscal_comprobable: 'Sólo ticket o recibo',
  no_comprobable: 'Sin comprobante',
};

export interface Departamento { code: string; nombre: string; sucursal: string; }

/**
 * El expediente de una solicitud, resumido para el tablero: qué estado tiene, cuál es
 * (para poder actuar) y QUÉ DOCUMENTOS hay. Los tres faltantes posibles —comprobante,
 * solicitud firmada, comprobación— son tres pendientes distintos para quien aprueba.
 */
export interface ProofByFolio {
  id: string;
  status: ProofStatus | string;
  comprobante?: boolean;
  solicitud?: boolean;
  clasificacion?: ExpenseClasificacion | string | null;
  requiere_evidencia?: boolean;
  tiene_comprobacion?: boolean | null;
  comprobacion_nota?: string | null;
}

export interface ExpenseProof {
  id: string;
  solicitante: string;
  departamento: string;
  departamento_code: string | null;
  sucursal: string | null;
  fecha_gasto: string | null;
  folio_solicitud: string;
  proveedor: string;
  importe: number;
  files: ProofFile[];
  comentarios: string | null;
  status: ProofStatus;
  clasificacion?: ExpenseClasificacion | string | null; // naturaleza del gasto (decide la evidencia)
  monto_ocr?: number | null;      // total leído de la foto (Claude Vision)
  monto_match?: boolean | null;   // cuadró vs el importe de la solicitud
  tiene_comprobacion?: boolean | null; // (XA1001, dormante) lo declaraba quien valida
  comprobacion_nota?: string | null;
  revision_nota?: string | null;  // por qué quedó en revisión
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ExpenseProofsReport {
  kpis: { total: number; recibidas: number; validadas: number; rechazadas: number; en_revision?: number };
  rows: ExpenseProof[];
}

/** Resultado del preview de validación por vision del comprobante. */
export interface ProofPhotoOcr {
  ocr_status: 'ok' | 'ilegible' | 'sin_key';
  importe_esperado: number;
  monto_ocr: number | null;
  monto_match: boolean;
  diff: number | null;
  total: number | null;
  subtotal: number | null;
}

export interface CreateExpenseProof {
  solicitante?: string;
  departamento?: string;
  departamento_code?: string;
  sucursal?: string;
  fecha_gasto?: string;
  folio_solicitud?: string;
  proveedor?: string;
  importe?: number;
  comentarios?: string;
  /** Naturaleza del gasto — obligatoria: decide si la evidencia es obligatoria. */
  clasificacion?: ExpenseClasificacion;
  /** `[GX.14]` Cómo se pagó — obligatoria. Catálogo en `@megadulces/contracts`. */
  forma_pago?: FormaPagoId;
  /** `[GX.14]` El dato que pide la forma elegida (caja, últimos 4, referencia, cheque). */
  forma_pago_detalle?: string;
  files?: ProofFile[];
  monto_ocr?: number | null;
  subtotal_ocr?: number | null;
  receipt_legible?: boolean;
}

/** Una solicitud de Kepler como candidata para adjuntarle el comprobante. */
export interface SolicitudSug {
  folio: string; sucursal: string | null; fecha: string | null; solicitante: string | null;
  beneficiario: string | null; concepto: string | null; estado: string | null; aplicada: boolean; importe: number;
}

/**
 * `[GX.14]` Resumen de lo que pidió ESTA persona.
 *
 * `medido: false` no es «cero»: es «no hay cómo saber cuáles son tuyas» (el usuario no
 * tiene áreas ni nombre que case). La pantalla tiene que decir el motivo, no pintar 0.
 */
export interface ResumenSolicitante {
  periodo: '12m' | 'mes';
  medido: boolean;
  motivo: string | null;
  alcance?: string;
  /** `promedio` y `mayor` llegan NULL cuando no hay solicitudes: sin datos no hay cifra. */
  totales: { n: number; monto: number; promedio: number | null; mayor: number | null } | null;
  por_mes: { mes: string; n: number; monto: number; en_curso: boolean }[];
  por_estado: { estado: string; label: string; n: number; monto: number }[];
  top_beneficiarios: { beneficiario: string; n: number; monto: number }[];
  /** El hallazgo que justifica pedir la forma de pago: cuántas de las suyas la traen. */
  forma_pago: { declarada: number; total: number } | null;
  evidencia: { con_expediente: number; total: number } | null;
}

/** Detalle + señal de si el bucket está configurado (para no confundir "sin adjunto" con "no lo puedo servir"). */
export interface ExpenseProofDetail extends ExpenseProof { storage_ok?: boolean; requiere_evidencia?: boolean; }

/** `[GX.15]` Un gasto de Kepler ya aplicado y todavía sin comprobación. */
export interface ListoParaComprobar {
  sucursal: string;
  folio_gasto: string;
  fecha_gasto: string | null;
  beneficiario: string | null;
  concepto: string | null;
  area: string | null;
  solicitud_folio: string;
  solicitud_estado: string | null;
  solicitante: string | null;
  importe: number;
  solicitud_importe: number | null;
  /** `null` = no hay solicitud contra la cual cuadrar, que NO es lo mismo que «no cuadra». */
  cuadra_con_solicitud: boolean | null;
}

/**
 * `[GX.15]` Respuesta de «lo que ya se puede comprobar».
 *
 * `medido: false` no es una lista vacía: es «no hay cómo saber cuáles son tuyas». Un vacío
 * a secas se lee como «no tenés nada pendiente», que es otra afirmación.
 */
export interface ListasParaComprobar {
  medido: boolean;
  motivo: string | null;
  /** La ventana es sobre la fecha de la SOLICITUD, no la del gasto. */
  ventana_dias: number;
  rows: ListoParaComprobar[];
}

/** `[GX.15]` El expediente completo: los cuatro eslabones + en qué etapa va el trámite. */
export interface ExpedienteGasto {
  sucursal: string;
  folio_solicitud: string;
  solicitud: Record<string, any> | null;
  expediente: Record<string, any> | null;
  /** Pueden ser VARIOS: 177 solicitudes en prod tienen más de un gasto aplicado. */
  gastos: Record<string, any>[];
  comprobaciones: Record<string, any>[];
  tramite: { etapa: string; label: string; falta: string[] };
  generado_at: string;
}

@Injectable({ providedIn: 'root' })
export class ComprobacionesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses/proofs`;

  list(q: { status?: string; folio_solicitud?: string; search?: string; from?: string; to?: string } = {}): Observable<ExpenseProofsReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<ExpenseProofsReport>(this.base, { params });
  }
  /**
   * Busca la SOLICITUD contra la que se sube el comprobante. El folio se resuelve por
   * valor numérico: teclear los últimos dígitos alcanza («23» → `0000023`).
   */
  searchSolicitudes(q: string, limit = 20): Observable<SolicitudSug[]> {
    return this.http.get<SolicitudSug[]>(`${this.base}/search-solicitudes`,
      { params: new HttpParams().set('q', q).set('limit', String(limit)) });
  }
  /** Lo que capturó este usuario (ruta propia, acotada por el token). */
  mine(limit = 50): Observable<ExpenseProofsReport> {
    return this.http.get<ExpenseProofsReport>(`${this.base}/mine`, { params: new HttpParams().set('limit', String(limit)) });
  }
  /**
   * Sube UN archivo (base64 data URI) y devuelve su referencia (bucket privado).
   *
   * `[GX.14]` `sello` marca la foto que salió de la cámara. Sin él, el backend la trata
   * como archivo y el 400 de la compuerta la rechaza — que es lo que queremos.
   */
  uploadFile(file_base64: string, role: ProofFileRole, sello?: { live?: boolean; captured_at?: string }): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role, live: sello?.live === true, captured_at: sello?.captured_at });
  }

  /** `[GX.14]` Resumen de lo que pidió este usuario. */
  resumen(periodo: '12m' | 'mes' = '12m'): Observable<ResumenSolicitante> {
    return this.http.get<ResumenSolicitante>(`${this.base}/resumen`, { params: new HttpParams().set('periodo', periodo) });
  }
  /** Preview: valida la foto del comprobante con Claude Vision contra el importe de la solicitud. */
  validatePhoto(file_base64: string, importe: number): Observable<ProofPhotoOcr> {
    return this.http.post<ProofPhotoOcr>(`${this.base}/validate-photo`, { file_base64, importe });
  }
  create(body: CreateExpenseProof): Observable<{ id: string; folio_solicitud: string; status: string }> {
    return this.http.post<{ id: string; folio_solicitud: string; status: string }>(this.base, body);
  }
  /**
   * Detalle con los adjuntos RE-FIRMADOS. La lista los firma con TTL de 10 min; quien
   * revisa abre la fila mucho después y la URL ya venció (se veía como archivo perdido).
   */
  detail(id: string): Observable<ExpenseProofDetail> {
    return this.http.get<ExpenseProofDetail>(`${this.base}/${id}`);
  }
  /** Valida el expediente. Puede reclasificar el gasto (si el capturista se equivocó). */
  validate(id: string, body?: { clasificacion?: string; comprobacion_nota?: string }): Observable<any> {
    return this.http.post(`${this.base}/${id}/validate`, body || {});
  }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  /** MOMENTO 2 — aprueba la solicitud capturada. Comprobable → aprobada; no comprobable → validada. */
  approve(id: string, body?: { clasificacion?: string; comprobacion_nota?: string }): Observable<any> {
    return this.http.post(`${this.base}/${id}/approve`, body || {});
  }
  /** MOMENTO 3 — sube la evidencia de un gasto ya aprobado y comprobable (cuadre por visión → validada/revision). */
  addEvidence(id: string, body: CreateExpenseProof): Observable<{ id: string; folio_solicitud: string; status: string }> {
    return this.http.post<{ id: string; folio_solicitud: string; status: string }>(`${this.base}/${id}/evidence`, body);
  }
  /** Estado del expediente de un folio (para saber en qué momento está la captura). Accesible al capturista. */
  /**
   * Clave del mapa folio→expediente. **El folio solo no alcanza**: en Kepler es único por
   * SUCURSAL. Medido en prod: 373 folios viven en más de una plaza (el `0000002` está en
   * cuatro). Buscar sólo por folio encendía el indicador en la fila de otra tienda.
   * Debe coincidir exacto con `proofKey()` del backend.
   */
  static key(sucursal: string | null | undefined, folio: string | null | undefined): string {
    return `${(sucursal ?? '').trim()}|${(folio ?? '').trim()}`;
  }

  proofByFolio(folio: string, sucursal?: string): Observable<ProofByFolio | null> {
    return this.http.get<ProofByFolio | null>(`${this.base}/proof-by-folio`, { params: (() => { let p = new HttpParams().set('folio', folio); if (sucursal) p = p.set('sucursal', sucursal); return p; })() });
  }
  departamentos(): Observable<Departamento[]> { return this.http.get<Departamento[]>(`${this.base}/departamentos`); }
  /** (C) folio_solicitud → estado, para el indicador en Solicitudes. */
  /** Estado + ID del último comprobante por folio de solicitud. El ID permite validar o
   *  rechazar desde donde se esté viendo, sin saltar a otra pantalla a buscarlo. */
  /** `[GX.15]` El expediente completo de una solicitud (los cuatro eslabones). */
  expediente(sucursal: string, folio: string): Observable<ExpedienteGasto> {
    return this.http.get<ExpedienteGasto>(`${environment.apiUrl}/finance/expenses/expediente/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}`);
  }

  /**
   * `[GX.15]` El expediente en PDF.
   *
   * Se pide como **blob**, no con un `<a href>`: la ruta exige el token y un enlace
   * directo lo manda sin cabecera de autorización — el navegador abriría un 401 en una
   * pestaña en blanco, que se ve como «el PDF no sirve».
   */
  expedientePdf(sucursal: string, folio: string): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/finance/expenses/expediente/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}/pdf`,
      { responseType: 'blob' });
  }

  /** `[GX.15]` Gastos ya aplicados en Kepler y sin comprobación, dentro del alcance. */
  listasParaComprobar(dias = 90, limit = 200): Observable<ListasParaComprobar> {
    return this.http.get<ListasParaComprobar>(`${environment.apiUrl}/finance/expenses/expediente/listas-para-comprobar`,
      { params: new HttpParams().set('dias', String(dias)).set('limit', String(limit)) });
  }

  statusByFolio(): Observable<Record<string, ProofByFolio>> { return this.http.get<Record<string, ProofByFolio>>(`${this.base}/status-by-folio`); }
}
