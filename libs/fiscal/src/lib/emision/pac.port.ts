/**
 * FE.0 — Puerto al PAC para EMISIÓN/timbrado de CFDI (facturas propias).
 *
 * Separado del `PacService` de logística (Carta Porte) para respetar la frontera
 * del dominio: `libs/fiscal` no importa `logistics`. El PAC de Mega Dulces es
 * SW SmarterWeb / Luna Soft (revendido por Conectia). Adapter por defecto: SW.
 */
export interface PacStampResult {
  uuid: string;
  serie?: string;
  folio?: string;
  xml?: string;
  pdf_base64?: string;
  no_certificado_sat?: string;
  fecha_timbrado?: string;
  sello_sat?: string;
  cadena_original_sat?: string;
  raw: unknown;
}

export interface PacCancelInput {
  uuid: string;
  rfc: string;              // RFC del emisor
  motivo?: string;          // 01|02|03|04 (default 02)
  folioSustitucion?: string; // requerido si motivo 01
}

export interface PacCancelResult {
  /** Estatus resultante normalizado: 'cancelado' | 'en_proceso_cancelacion' | 'rechazado' | 'desconocido'. */
  estatus: 'cancelado' | 'en_proceso_cancelacion' | 'rechazado' | 'desconocido';
  /** Acuse de cancelación del SAT (XML crudo o base64), si el PAC lo devuelve. */
  acuse?: string | null;
  /** Códigos por UUID que devuelve el PAC (ej. {"<uuid>":"201"}). */
  codes?: Record<string, string>;
  raw: unknown;
}

export interface PacStatusResult {
  /** EstadoComprobante SAT: 'Vigente' | 'Cancelado' | 'No Encontrado'. */
  estado?: string;
  es_cancelable?: string;      // 'Cancelable sin aceptación' | 'Cancelable con aceptación' | 'No cancelable'
  estatus_cancelacion?: string; // 'En proceso' | 'Cancelado sin aceptación' | ...
  raw: unknown;
}

export interface PacPort {
  readonly provider: string;
  /** Timbra un CFDI 4.0 a partir del JSON del comprobante. */
  stamp(cfdiJson: unknown): Promise<PacStampResult>;
  /** Cancela un CFDI ya timbrado ante el SAT. Devuelve estatus normalizado + acuse. */
  cancel(input: PacCancelInput): Promise<PacCancelResult>;
  /** Consulta el estatus del CFDI ante el SAT (vigente/cancelado). Null si no se pudo. */
  status(input: { uuid: string; emisorRfc: string; receptorRfc: string; total: string | number }): Promise<PacStatusResult | null>;
  /** Genera la representación impresa (PDF, base64) desde el XML timbrado. */
  pdf(xml: string): Promise<string | null>;
}

export const PAC_PORT = Symbol('FISCAL_PAC_PORT');
