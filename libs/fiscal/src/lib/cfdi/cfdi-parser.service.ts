import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { CfdiHeader, CfdiPaymentLink } from './cfdi.types';

/**
 * FISCAL.4.2 — Parser de CFDI 4.0 (XML → cabecera estructurada).
 *
 * Puntos finos:
 *  - `parseAttributeValue: false`: NO coercionar atributos a número. Si se coercen,
 *    RFCs/folios como "0012" se vuelven 12 (bug clásico). Los numéricos reales
 *    (subtotal/total/tasas) se convierten a mano con num().
 *  - `removeNSPrefix: true`: quita `cfdi:`/`tfd:` → nodos planos (Comprobante, Emisor,
 *    TimbreFiscalDigital), robusto ante variaciones de prefijo de namespace.
 *  - El complemento puede traer varios hijos y venir como objeto o arreglo.
 */
@Injectable()
export class CfdiParserService {
  private readonly logger = new Logger(CfdiParserService.name);
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    removeNSPrefix: true,
    trimValues: true,
  });

  /** Parsea un XML de CFDI. Devuelve null si no es un Comprobante timbrado (sin UUID). */
  parse(xml: string): CfdiHeader | null {
    let doc: any;
    try {
      doc = this.parser.parse(xml);
    } catch (e: any) {
      this.logger.warn(`XML no parseable: ${e?.message || e}`);
      return null;
    }
    const c = doc?.Comprobante;
    if (!c) return null;

    const emisor = this.one(c.Emisor);
    const receptor = this.one(c.Receptor);
    const imp = this.one(c.Impuestos);
    const tfd = this.findTimbre(c.Complemento);
    const uuid = this.attr(tfd, 'UUID');
    if (!uuid) return null; // sin timbre no es un CFDI válido para el almacén

    const tipoComprobante = this.attr(c, 'TipoDeComprobante');
    const pagos = tipoComprobante === 'P' ? this.extractPagos(c.Complemento) : undefined;

    return {
      uuid: uuid.toUpperCase(),
      version: this.attr(c, 'Version'),
      tipoComprobante,
      serie: this.attr(c, 'Serie'),
      folio: this.attr(c, 'Folio'),
      fecha: this.attr(c, 'Fecha'),
      fechaTimbrado: this.attr(tfd, 'FechaTimbrado'),
      emisorRfc: this.upper(this.attr(emisor, 'Rfc')),
      emisorNombre: this.attr(emisor, 'Nombre'),
      emisorRegimen: this.attr(emisor, 'RegimenFiscal'),
      receptorRfc: this.upper(this.attr(receptor, 'Rfc')),
      receptorNombre: this.attr(receptor, 'Nombre'),
      receptorUsoCfdi: this.attr(receptor, 'UsoCFDI'),
      receptorRegimen: this.attr(receptor, 'RegimenFiscalReceptor'),
      receptorDomicilio: this.attr(receptor, 'DomicilioFiscalReceptor'),
      subtotal: this.num(this.attr(c, 'SubTotal')),
      descuento: this.num(this.attr(c, 'Descuento')),
      total: this.num(this.attr(c, 'Total')),
      moneda: this.attr(c, 'Moneda'),
      tipoCambio: this.num(this.attr(c, 'TipoCambio')),
      metodoPago: this.attr(c, 'MetodoPago'),
      formaPago: this.attr(c, 'FormaPago'),
      lugarExpedicion: this.attr(c, 'LugarExpedicion'),
      noCertificado: this.attr(c, 'NoCertificado'),
      noCertificadoSat: this.attr(tfd, 'NoCertificadoSAT'),
      pacRfc: this.upper(this.attr(tfd, 'RfcProvCertif')),
      totalTrasladados: this.num(this.attr(imp, 'TotalImpuestosTrasladados')),
      totalRetenidos: this.num(this.attr(imp, 'TotalImpuestosRetenidos')),
      conceptosCount: this.countConceptos(c.Conceptos),
      impuestos: imp ?? null,
      pagos,
    };
  }

  /**
   * Extrae los DoctoRelacionado del complemento de pago (REP, Pagos 1.0/2.0).
   * Con removeNSPrefix el árbol es Complemento(.Pagos|[]).Pago[].DoctoRelacionado[].
   */
  private extractPagos(complemento: any): CfdiPaymentLink[] {
    if (!complemento) return [];
    const nodes = Array.isArray(complemento) ? complemento : [complemento];
    const pagosNode = nodes.map((n) => n?.Pagos).find(Boolean);
    if (!pagosNode) return [];
    const pagos = this.arr(this.one(pagosNode).Pago);
    const links: CfdiPaymentLink[] = [];
    for (const p of pagos) {
      const fechaPago = this.attr(p, 'FechaPago');
      const formaPago = this.attr(p, 'FormaDePagoP');
      const monedaP = this.attr(p, 'MonedaP');
      for (const dr of this.arr(p?.DoctoRelacionado)) {
        const doctoUuid = this.attr(dr, 'IdDocumento');
        if (!doctoUuid) continue;
        links.push({
          doctoUuid: doctoUuid.toUpperCase(),
          fechaPago,
          formaPago,
          moneda: this.attr(dr, 'MonedaDR') ?? monedaP,
          numParcialidad: this.num(this.attr(dr, 'NumParcialidad')) ?? null,
          impSaldoAnt: this.num(this.attr(dr, 'ImpSaldoAnt')),
          impPagado: this.num(this.attr(dr, 'ImpPagado')),
          impSaldoInsoluto: this.num(this.attr(dr, 'ImpSaldoInsoluto')),
        });
      }
    }
    return links;
  }

  /** Normaliza a arreglo (fast-xml-parser da objeto si hay uno solo). */
  private arr(v: any): any[] {
    return v == null ? [] : Array.isArray(v) ? v : [v];
  }

  /** Localiza el TimbreFiscalDigital dentro del Complemento (objeto o arreglo). */
  private findTimbre(complemento: any): any {
    if (!complemento) return null;
    const nodes = Array.isArray(complemento) ? complemento : [complemento];
    for (const n of nodes) {
      if (!n) continue;
      if (n.TimbreFiscalDigital) return this.one(n.TimbreFiscalDigital);
    }
    return null;
  }

  private countConceptos(conceptos: any): number {
    const c = conceptos?.Concepto;
    if (!c) return 0;
    return Array.isArray(c) ? c.length : 1;
  }

  /** Primer elemento si es arreglo; el objeto si no. */
  private one(v: any): any {
    return Array.isArray(v) ? v[0] : v;
  }

  private attr(node: any, name: string): string | null {
    if (!node) return null;
    const v = node[`@_${name}`];
    return v == null || v === '' ? null : String(v);
  }

  private num(v: string | null): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private upper(v: string | null): string | null {
    return v == null ? null : v.toUpperCase();
  }
}
