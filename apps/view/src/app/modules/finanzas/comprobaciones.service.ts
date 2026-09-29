import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
// [GX.14] El catálogo de formas de pago y la compuerta NO se copian acá: se importan del
// contrato compartido, que es el mismo que valida el backend.
import type { FormaPagoId } from '@megadulces/contracts';
// `[GX.39]` El tipo de la etapa viene del contrato compartido: escribirlo a mano acá es
// exactamente cómo se desincroniza sin que nadie vea (pasó con `reapertura`, GX.30).
import type { AutorizacionKepler, EtapaEjercicio, ValeAsignado } from '@megadulces/contracts';

/** GX.7 — cliente de solicitudes de reembolso (captura multi-archivo + validación). */

export type ProofStatus = 'recibida' | 'aprobada' | 'validada' | 'rechazada' | 'revision';

/** Roles de archivo del formulario (Google Form → plataforma). */
export type ProofFileRole = 'comprobante_1' | 'comprobante_2' | 'comprobante_3' | 'comprobante_4'
  | 'solicitud_kepler' | 'cotizacion' | 'cotizacion_2' | 'cotizacion_3'
  | 'evidencia_1' | 'evidencia_2' | 'evidencia_3';

/** [GX.23] Los roles de cada familia, en orden: la pantalla toma el primero libre. */
export const ROLES_COMPROBANTE: ProofFileRole[] = ['comprobante_1', 'comprobante_2', 'comprobante_3', 'comprobante_4'];
export const ROLES_COTIZACION: ProofFileRole[] = ['cotizacion', 'cotizacion_2', 'cotizacion_3'];
/**
 * `[GX.33]` Los adjuntos de CUALQUIER tipo. Los roles ya existían en el contrato y no los
 * usaba ninguna pantalla: acá entran el `.pdf` del proveedor, el `.xlsx` del presupuesto o
 * el `.docx` del convenio — lo que el gasto traiga y no sea una foto ni una cotización.
 */
export const ROLES_EVIDENCIA: ProofFileRole[] = ['evidencia_1', 'evidencia_2', 'evidencia_3'];
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
  // `[GX.31]` «Vale autorizado», no «Sin comprobante». GX.18 lo renombró en la lista
  // local de la captura y NO acá, que es la que leen Aprobación y el Historial: la
  // persona capturaba «Vale autorizado» y quien firma veía «Sin comprobante» — el mismo
  // gasto con dos nombres, y el segundo además miente, porque desde GX.18 ese tipo SÍ
  // lleva foto. Lo que no lleva es comprobante FISCAL.
  no_comprobable: 'Vale autorizado',
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
  // `[GX.32]` Los sigue devolviendo el servidor para los expedientes VIEJOS, cerrados
  // cuando existía el cuadre por visión. Para los nuevos llegan en null — la columna se
  // conserva, dejó de escribirse.
  monto_ocr?: number | null;
  monto_match?: boolean | null;
  tiene_comprobacion?: boolean | null; // (XA1001, dormante) lo declaraba quien valida
  comprobacion_nota?: string | null;
  /** `[GX.27]` La forma de pago viaja en el listado porque el visor del vale la muestra. */
  forma_pago?: string | null;
  forma_pago_detalle?: string | null;
  revision_nota?: string | null;  // por qué quedó en revisión
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
  /**
   * `[GX.39]` **La etapa de EJERCICIO**: lo que pasa después de que firmamos, del lado de
   * Kepler. NO se calcula acá — la decide `etapaDeEjercicio()` en el servidor, con la misma
   * función que probaría el frontend si la calculara. Viaja resuelta para que no haya dos
   * reglas.
   *
   * ⚠️ `sin_medir` no es «por ejercer»: es que no pudimos ver el estado en Kepler. Se
   * muestra como tal (ADR-056).
   */
  etapa?: EtapaEjercicio;
  etapa_label?: string;
  etapa_explicacion?: string;
  /**
   * `[GX.54]` Aprobado **debiendo** el comprobante: entró con una cotización o prefactura.
   * Decide qué tarea se le muestra a quien lo levantó — la factura del pago, no «evidencia».
   */
  provisional?: boolean | null;
  /** `[GX.48]` El identificador que muestra «Autorización de Sol Gasto»: `XA1501-0009008`. */
  documento_kepler?: string | null;
  /**
   * `[GX.48]` La constancia de autorización. **Se genera**, no se jala: Kepler no guarda
   * ningún documento al autorizar (medido). `null` mientras no tenga la `A`.
   */
  autorizacion_kepler?: AutorizacionKepler | null;
}

export interface ExpenseProofsReport {
  kpis: { total: number; recibidas: number; validadas: number; rechazadas: number; en_revision?: number };
  /**
   * `[GX.39]` ⚠️ Se llama `de_la_pagina` **a propósito**: son las filas que vinieron, no el
   * universo. La etapa sale de cruzar con Kepler, no es una columna de la tabla, y cruzar
   * los miles de folios del tenant para pintar tres números costaría más de lo que vale.
   * Leerlo como total es la trampa que GX.35 ya cobró una vez con estos mismos KPI.
   */
  etapas_de_la_pagina?: Record<string, number>;
  /**
   * `[GX.41]` Los vales que **Kepler le asignó** a esta persona por la caja «Solicita», y que
   * todavía **no tienen expediente nuestro**. No son `ExpenseProof`: no tienen `id`, `status`
   * ni archivos, porque no existen de este lado. Se vuelven expediente cuando les sube la
   * evidencia. Sólo viene en `/mine`.
   */
  asignados?: ValeAsignado[];
  rows: ExpenseProof[];
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
  // `[GX.32]` Se fueron `monto_ocr`, `subtotal_ocr` y `receipt_legible`: los llenaba el
  // preview por visión y el servidor ya no los recibe.
}

/** Una solicitud de Kepler como candidata para adjuntarle el comprobante. */
export interface SolicitudSug {
  folio: string; sucursal: string | null; fecha: string | null; solicitante: string | null;
  beneficiario: string | null; concepto: string | null; estado: string | null; aplicada: boolean; importe: number;
  /**
   * [GX.21] Lo que la vista del ODS ya traia y no se pedia. Todo opcional: una solicitud
   * vieja puede no tener RFC ni referencia, y eso se DECLARA con un guion en pantalla --
   * nunca se rellena con un cero o una cadena vacia que parezca un dato.
   */
  rfc?: string | null; iva?: number | null; autoriza?: string | null; referencia?: string | null;
  cuenta_clave?: string | null; usuario?: string | null; forma_pago?: string | null;
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

/**
 * `[GX.20]` **El dia del gasto.** Lo que devuelve `GET /del-dia`, tipado del lado del
 * cliente porque cruza el boundary REST (ADR-052). Los nombres son los del servidor: si
 * alguien renombra un campo alla, esto deja de compilar en vez de mostrar `undefined`.
 */

/**
 * Las bandejas del dia, por la DECISION que se tomo sobre el expediente:
 *   entrada    = `recibida`                           -> nadie decidio todavia
 *   aprobados  = `aprobada` | `revision` | `validada` -> se dijo que si (3 momentos del cierre)
 *   rechazados = `rechazada`                          -> se dijo que no
 * `sin_etapa` no es una pestana: es un estado que el servidor no reconocio.
 */
export type EtapaGasto = 'entrada' | 'aprobados' | 'rechazados' | 'sin_etapa';
/** Las tres pestanas, en el orden en que se leen. Particionan el dia: cada expediente se
 *  ve en una y solo una. */
export type PestanaGasto = 'entrada' | 'aprobados' | 'rechazados';

export interface GrupoAprobacion {
  clave: string;
  etiqueta: string;
  /** Solo en los grupos por departamento: de donde salio la etiqueta. */
  origen?: 'capturado' | 'solicitud' | 'sin_clasificar';
  n: number;
  monto: number;
  ids: string[];
}

export interface ExpedienteDelDia {
  id: string;
  folio_solicitud: string;
  sucursal: string | null;
  /** Cuando OCURRIO el gasto. No es el dia de la pantalla — ver `created_at`. */
  fecha_gasto: string | null;
  /** Cuando se LEVANTO el expediente (`YYYY-MM-DD`, Mexico). Es el dia que filtra. */
  created_at: string;
  created_hora: string;
  importe: number;
  departamento: string | null;
  solicitante: string | null;
  concepto: string | null;
  proveedor: string | null;
  clasificacion: string | null;
  forma_pago: string | null;
  forma_pago_detalle: string | null;
  comentarios: string | null;
  created_by: string | null;
  status: ProofStatus | string;
  etapa: EtapaGasto;
  motivo_rechazo: string | null;
  revision_nota: string | null;
  validated_by: string | null;
  validated_at: string | null;
  requiere_evidencia: boolean;
  tiene_evidencia: boolean;
  evidencia_en_vivo: boolean;
  files: ProofFile[];
}

/**
 * `[GX.27]` Lo que el **visor del vale** necesita para pintar un expediente.
 *
 * Es el minimo comun: `ExpedienteDelDia` (la pantalla de Aprobacion) y `ExpenseProof` (el
 * Historial) son asignables a esto. Existe para que el visor sea UNO solo -- dos visores son
 * dos lugares donde arreglar el mismo error, y dos que pueden empezar a mostrar cosas
 * distintas del mismo expediente.
 *
 * (!) Los campos OPCIONALES no son "puede no existir": son "este endpoint no los manda".
 * `created_hora` y `concepto` solo vienen de `/del-dia`. El visor los omite cuando faltan, en
 * vez de pintar un guion -- un guion afirma que el expediente no los tiene, y eso seria falso.
 */
export interface ValeGasto {
  id: string;
  folio_solicitud: string | null;
  sucursal: string | null;
  /** Cuando OCURRIO el gasto. Puede ser de otro dia que el levantamiento. */
  fecha_gasto: string | null;
  /** Cuando se LEVANTO (`YYYY-MM-DD` o ISO completo; el visor lo normaliza). */
  created_at: string;
  /** `HH:MM`. `undefined` = este endpoint no lo manda. */
  created_hora?: string;
  importe: number;
  departamento: string | null;
  solicitante?: string | null;
  /** Concepto de la solicitud de Kepler. `undefined` = este endpoint no lo trae. */
  concepto?: string | null;
  proveedor: string | null;
  clasificacion?: string | null;
  forma_pago?: string | null;
  forma_pago_detalle?: string | null;
  comentarios: string | null;
  created_by: string | null;
  status: ProofStatus | string;
  motivo_rechazo: string | null;
  revision_nota?: string | null;
  validated_by: string | null;
  requiere_evidencia?: boolean;
  tiene_evidencia?: boolean;
  evidencia_en_vivo?: boolean;
  files: ProofFile[];
  /**
   * `[GX.48]` La constancia de autorización de Kepler. **Se genera**, no se jala: Kepler no
   * guarda ningún documento al autorizar (medido de cinco formas, ver `ejercicio.contract`).
   *
   * ⚠️ Opcional porque **no todos los endpoints la mandan**: viaja en `/mine` y en el detalle,
   * pero la bandeja de Aprobación arma el vale con otras columnas. `undefined` ahí significa
   * «este endpoint no la trae», que no es lo mismo que `null` = «el vale no está autorizado».
   */
  autorizacion_kepler?: AutorizacionKepler | null;
}

export interface GastosDelDia {
  fecha: string;
  es_hoy: boolean;
  /** Hoy segun el SERVIDOR. La pantalla no calcula el dia con el reloj del navegador. */
  hoy: string;
  /** No-null = la fecha que se pidio era ilegible y el servidor cayo a hoy. */
  fecha_pedida: string | null;
  total: number;
  monto_total: number;
  etapas: Record<EtapaGasto, { n: number; monto: number }>;
  filas: ExpedienteDelDia[];
  /** Los grupos por departamento de la bandeja de entrada de ESE dia. */
  entrada: { total: number; monto_total: number; por_fecha: GrupoAprobacion[]; por_departamento: GrupoAprobacion[] };
  /** Lo que espera firma y NO es de este dia. Sin esto, acotar por dia esconderia trabajo. */
  pendientes_fuera_del_dia: { n: number; monto: number };
}

/**
 * `[GX.30]` La forma la manda el SERVIDOR: vive en `libs/contracts` y se re-exporta acá
 * para no romperle el import a nadie. Estaba escrita a mano de los dos lados — empieza
 * idéntica y termina distinta, y el día que se desincroniza compila igual.
 */
import type { ReaperturaPendiente } from '@megadulces/contracts';
export type { ReaperturaPendiente };

/** `[GX.27]` Un dia del calendario del historial. Solo viajan los dias CON movimiento. */
export interface DiaDelCalendario { dia: string; n: number; monto: number }

export interface CalendarioDelMes {
  mes: string;
  /** No-null = el mes que se pidio era ilegible y el servidor cayo al actual. */
  mes_pedido: string | null;
  dias: DiaDelCalendario[];
  total: { n: number; monto: number };
  alcance: 'mios' | 'todos';
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
  /**
   * `[GX.49]` Abrir UN vale concreto (desde «Subir evidencia»). **No es el buscador**: pide
   * folio Y sucursal y, por eso, puede traer un vale de cualquier fecha. El buscador filtra a
   * HOY —correcto para teclear— y por eso no podía abrir un vale de ayer.
   */
  solicitudExacta(folio: string, sucursal: string): Observable<SolicitudSug[]> {
    return this.http.get<SolicitudSug[]>(`${this.base}/solicitud-exacta`,
      { params: new HttpParams().set('folio', folio).set('sucursal', sucursal) });
  }

  searchSolicitudes(q: string, limit = 20): Observable<SolicitudSug[]> {
    return this.http.get<SolicitudSug[]>(`${this.base}/search-solicitudes`,
      { params: new HttpParams().set('q', q).set('limit', String(limit)) });
  }
  /**
   * `[GX.20]` Los levantamientos de gasto de UN dia, ya partidos en Aprobar / Ejercer /
   * Todos por el servidor. Sin `fecha` contesta con HOY en hora de Mexico — que es el
   * unico reloj que vale: el del navegador puede estar en otra zona.
   */
  delDia(fecha?: string, limit = 500): Observable<GastosDelDia> {
    let params = new HttpParams().set('limit', String(limit));
    if (fecha) params = params.set('fecha', fecha);
    return this.http.get<GastosDelDia>(`${this.base}/del-dia`, { params });
  }

  /**
   * `[GX.27]` El mes del historial: por dia, cuantos levantamientos y cuanto sumaron.
   *
   * (!) El `alcance` lo VALIDA el servidor: pedir `todos` sin god-mode devuelve 403, no una
   * version recortada. Aca se manda lo que la pantalla puede ofrecer; la puerta esta alla.
   */
  calendario(mes?: string, alcance: 'mios' | 'todos' = 'mios'): Observable<CalendarioDelMes> {
    let params = new HttpParams().set('alcance', alcance);
    if (mes) params = params.set('mes', mes);
    return this.http.get<CalendarioDelMes>(`${this.base}/calendario`, { params });
  }

  /**
   * `[GX.27]` Los levantamientos de UN dia, con el mismo alcance que el calendario.
   *
   * (X) La ruta cambia con el alcance, y no es cosmetico: `/mine` esta acotada por el token
   * y la coleccion es god-mode (`[GX.26]`). Pedir el dia "de todos" sin permiso devuelve 403.
   */
  delDiaHistorial(dia: string, alcance: 'mios' | 'todos' = 'mios', limit = 200): Observable<ExpenseProofsReport> {
    const params = new HttpParams().set('dia', dia).set('limit', String(limit));
    const url = alcance === 'todos' ? this.base : `${this.base}/mine`;
    return this.http.get<ExpenseProofsReport>(url, { params });
  }
  /**
   * Lo que capturó este usuario (ruta propia, acotada por el token).
   *
   * `[GX.25]` De TODAS las fechas, no sólo de hoy: es un historial. El buscador va contra
   * folio, proveedor y solicitante — los tres campos con los que alguien recuerda un gasto.
   */
  mine(limit = 200, search?: string): Observable<ExpenseProofsReport> {
    let params = new HttpParams().set('limit', String(limit));
    if (search?.trim()) params = params.set('search', search.trim());
    return this.http.get<ExpenseProofsReport>(`${this.base}/mine`, { params });
  }

  /**
   * `[GX.25]` El historial de TODOS los que levantaron gastos. Exige `FINANCE_EXPENSES_VER`
   * del lado del servidor: quien sólo captura ve lo suyo por `mine`, no esto.
   */
  historial(limit = 200, search?: string): Observable<ExpenseProofsReport> {
    let params = new HttpParams().set('limit', String(limit));
    if (search?.trim()) params = params.set('search', search.trim());
    return this.http.get<ExpenseProofsReport>(this.base, { params });
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
  // `[GX.32]` Se fue `validatePhoto()`: era el preview del cuadre por visión, y su
  // endpoint ya no existe en `expense-proofs`. Llamarlo ahora daría 404.
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
  /**
   * MOMENTO 2 — aprueba la solicitud capturada. Comprobable → aprobada; no comprobable → validada.
   *
   * `[GX.30]` `provisional` = «apruebo, pero lo que trae es una prefactura o una cotizacion,
   * no el comprobante». El dinero sale igual; lo que cambia es que la deuda documental queda
   * DECLARADA con su fecha esperada, en vez de confundirse con un vale ya cerrado.
   */
  approve(id: string, body?: {
    clasificacion?: string; comprobacion_nota?: string;
    provisional?: boolean; comprobante_esperado_at?: string;
  }): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.base}/${id}/approve`, body || {});
  }


  /** `[GX.29]` El capturista PIDE que le reabran su vale. No lo reabre: deja la solicitud. */
  pedirReapertura(id: string, motivo: string): Observable<{ id: string; estado: string }> {
    return this.http.post<{ id: string; estado: string }>(`${this.base}/${id}/reapertura`, { motivo });
  }

  /** `[GX.29]` Lo que le toca decidir a QUIEN PREGUNTA: solo los vales que esa persona aprobo. */
  reaperturasPendientes(): Observable<ReaperturaPendiente[]> {
    return this.http.get<ReaperturaPendiente[]>(`${this.base}/reaperturas/pendientes`);
  }

  /** `[GX.29]` La decision. Al autorizar, el vale vuelve a la bandeja del dia con `vuelta + 1`. */
  decidirReapertura(solicitudId: string, aprueba: boolean, nota?: string): Observable<{ proof_id: string; reabierto: boolean }> {
    return this.http.post<{ proof_id: string; reabierto: boolean }>(`${this.base}/reaperturas/${solicitudId}/decidir`, { aprueba, nota });
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
