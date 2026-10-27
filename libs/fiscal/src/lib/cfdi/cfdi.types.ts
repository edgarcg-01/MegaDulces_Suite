/**
 * FISCAL.5.1 — Un DoctoRelacionado del complemento de pago (REP): la factura PPD
 * que este CFDI tipo 'P' liquida (total o parcial).
 */
export interface CfdiPaymentLink {
  doctoUuid: string;        // IdDocumento (UUID de la factura pagada)
  fechaPago: string | null;
  formaPago: string | null;
  moneda: string | null;
  numParcialidad: number | null;
  impSaldoAnt: number | null;
  impPagado: number | null;
  impSaldoInsoluto: number | null;
  /**
   * `[PGP.23]` `CtaBeneficiario` del nodo `Pago`: LA CUENTA DEL PROVEEDOR, declarada por el
   * proveedor mismo. TEXTO CRUDO — 18 digitos = CLABE, 10 = cuenta de banco (no sirve sola
   * para SPEI). Es OPCIONAL en el CFDI: medido, solo el 37% de los emisores la llena.
   */
  ctaBeneficiario: string | null;
  /** `RfcEmisorCtaBen`: el banco del proveedor. Da el banco de una cuenta de 10 digitos. */
  rfcBancoBeneficiario: string | null;
}

/**
 * FISCAL.4.2 — Cabecera de un CFDI 4.0 ya parseado (lo que persiste fiscal.cfdis).
 */
export interface CfdiHeader {
  uuid: string;
  version: string | null;
  tipoComprobante: string | null; // I|E|T|N|P
  serie: string | null;
  folio: string | null;
  fecha: string | null;           // ISO (emisión)
  fechaTimbrado: string | null;
  emisorRfc: string | null;
  emisorNombre: string | null;
  emisorRegimen: string | null;
  receptorRfc: string | null;
  receptorNombre: string | null;
  receptorUsoCfdi: string | null;
  receptorRegimen: string | null;
  receptorDomicilio: string | null;
  subtotal: number | null;
  descuento: number | null;
  total: number | null;
  moneda: string | null;
  tipoCambio: number | null;
  metodoPago: string | null;      // PUE|PPD
  formaPago: string | null;
  lugarExpedicion: string | null;
  noCertificado: string | null;
  noCertificadoSat: string | null;
  pacRfc: string | null;
  totalTrasladados: number | null;
  totalRetenidos: number | null;
  conceptosCount: number;
  impuestos: unknown;             // nodo Impuestos crudo (traslados/retenciones)
  pagos?: CfdiPaymentLink[];      // solo tipo 'P': DoctoRelacionado del complemento REP
}
