/** FE.2 — DTOs de emisión de facturas (CFDI 4.0). */

export type TipoFactura = 'global' | 'nominativa';

export interface ConceptoInput {
  clave_prod_serv?: string;   // ClaveProdServ SAT (default 01010101)
  no_identificacion?: string; // SKU / clave interna
  descripcion: string;
  cantidad: number;
  clave_unidad?: string;      // ClaveUnidad SAT (default H87)
  unidad?: string;            // texto (default Pieza)
  valor_unitario: number;
  descuento?: number;
  objeto_imp?: string;        // 01 = no objeto · 02 = sí objeto (default 02)
  tasa_iva?: number;          // default 0.16 (aplica si objeto_imp = 02)
}

export interface ReceptorInput {
  rfc: string;
  nombre: string;             // debe coincidir EXACTO con el SAT (CFDI 4.0)
  regimen_fiscal: string;     // RegimenFiscalReceptor
  domicilio_cp: string;       // DomicilioFiscalReceptor (CP)
  uso_cfdi: string;           // UsoCFDI
}

export interface EmitirFacturaInput {
  tipo: TipoFactura;
  emisor_rfc?: string;        // si no, usa el emisor default activo
  serie?: string;
  forma_pago?: string;        // default 01 (efectivo)
  metodo_pago?: string;       // default PUE
  moneda?: string;            // default MXN
  receptor?: ReceptorInput;   // requerido si tipo = nominativa
  conceptos: ConceptoInput[];
  periodicidad?: string;      // factura global: 01 diario (default) ..05 bimestral
  order_id?: string;          // vínculo opcional a commercial.orders (FE.5)
  // FE.12 — Egreso (nota de crédito): TipoDeComprobante 'E' + CFDI relacionado.
  tipo_comprobante?: 'I' | 'E';                             // default I (Ingreso)
  relacionados?: { tipo_relacion: string; uuids: string[] }; // ej. { tipo_relacion:'01', uuids:[<uuid original>] }
}

/** FE.12 — nota de crédito (Egreso) sobre un CFDI emitido. El receptor se deriva del original. */
export interface NotaCreditoInput {
  emisor_rfc?: string;
  serie?: string;
  forma_pago?: string;
  metodo_pago?: string;
  conceptos: ConceptoInput[];
}

/** FE.8 — Complemento de Pago (REP): CFDI tipo 'P' con Pagos 2.0 sobre una factura PPD. */
export interface RepInput {
  cfdi_uuid: string;        // UUID de la factura PPD original
  monto: number;            // importe de ESTE pago
  forma_pago: string;       // clave SAT (01 efectivo, 03 transferencia, 04 tarjeta…)
  fecha_pago?: string;      // ISO 'YYYY-MM-DDTHH:MM:SS' (default: ahora MX)
  num_parcialidad: number;  // nº de parcialidad (1, 2, …)
  imp_saldo_ant: number;    // saldo ANTES de este pago
  imp_saldo_insoluto: number; // saldo DESPUÉS de este pago
  emisor_rfc?: string;
  serie?: string;           // default 'P'
}

export interface IssuerConfigInput {
  rfc: string;
  tax_name: string;
  regimen_fiscal: string;
  cp: string;                 // lugar de expedición
  serie?: string;
  pac_provider?: string;      // default sw
  is_default?: boolean;
}
