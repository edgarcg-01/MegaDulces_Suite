// FE.5 — Port de emisión de facturas: el dominio COMERCIAL (al entregar un pedido)
// dispara la emisión de un CFDI, pero el timbrado vive en FISCAL (libs/fiscal →
// EmisionService/PAC). commercial NO puede cruzar la frontera, así que empuja por
// este token + interface (@Optional); el binding al impl real (adapter sobre
// EmisionService) se hace en el composition root (app.module).
//
// Si no hay binding (o fiscal/PAC apagado), commercial sigue operando sin facturar
// —el pedido se entrega igual—: es best-effort. La forma de IssueInvoiceInput es
// espejo de EmitirFacturaInput (libs/fiscal) para que el adapter sea passthrough.

export const INVOICE_ISSUER_PORT = 'INVOICE_ISSUER_PORT';

export interface InvoiceConceptoInput {
  descripcion: string;
  cantidad: number;
  valor_unitario: number;
  clave_prod_serv?: string;
  clave_unidad?: string;
  unidad?: string;
  no_identificacion?: string;
  objeto_imp?: string; // 01 no objeto · 02 sí objeto (default 02)
  tasa_iva?: number;   // default 0.16
}

export interface InvoiceReceptorInput {
  rfc: string;
  nombre: string;          // razón social EXACTA (CFDI 4.0)
  regimen_fiscal: string;  // RegimenFiscalReceptor
  domicilio_cp: string;    // DomicilioFiscalReceptor (CP)
  uso_cfdi: string;        // UsoCFDI
}

export interface IssueInvoiceInput {
  tipo: 'global' | 'nominativa';
  order_id?: string;
  emisor_rfc?: string;
  serie?: string;
  forma_pago?: string;
  metodo_pago?: string;
  moneda?: string;
  receptor?: InvoiceReceptorInput; // requerido si nominativa
  conceptos: InvoiceConceptoInput[];
  periodicidad?: string;           // factura global
}

export interface IssueInvoiceResult {
  uuid: string;
  serie: string;
  folio: string;
  total: number;
}

export interface InvoiceIssuerPort {
  /** Emite y timbra un CFDI. Best-effort desde hooks: el caller debe tolerar throw/null. */
  issue(tenantId: string, input: IssueInvoiceInput): Promise<IssueInvoiceResult | null>;
}
