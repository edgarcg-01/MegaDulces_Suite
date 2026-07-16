import { Injectable, Logger } from '@nestjs/common';
import { InvoiceIssuerPort, IssueInvoiceInput, IssueInvoiceResult } from '@megadulces/contracts';
import { EmisionService } from './emision.service';
import { EmitirFacturaInput } from './emision.types';

/**
 * FE.5 — Adapter que liga el puerto `INVOICE_ISSUER_PORT` (contracts, disparado por
 * commercial al entregar un pedido) con el motor de emisión (EmisionService).
 * `IssueInvoiceInput` es espejo de `EmitirFacturaInput`, así que es passthrough.
 * El binding vive en el composition root (invoice-issuer.binding.module).
 */
@Injectable()
export class OrderInvoiceIssuerService implements InvoiceIssuerPort {
  private readonly logger = new Logger(OrderInvoiceIssuerService.name);

  constructor(private readonly emision: EmisionService) {}

  async issue(_tenantId: string, input: IssueInvoiceInput): Promise<IssueInvoiceResult | null> {
    const r = await this.emision.emitir(input as EmitirFacturaInput);
    return { uuid: r.uuid, serie: r.serie, folio: r.folio, total: r.total };
  }

  /** FE.7 — XML timbrado por UUID (tenant vía CLS). */
  async getXml(_tenantId: string, uuid: string): Promise<string | null> {
    try {
      return await this.emision.getXml(uuid);
    } catch (e: any) {
      this.logger.warn(`getXml(${uuid}) falló: ${e?.message || e}`);
      return null;
    }
  }

  /** FE.7 — PDF (base64) por UUID; EmisionService lo genera/cachea. */
  async getPdf(_tenantId: string, uuid: string): Promise<string | null> {
    try {
      return await this.emision.getPdf(uuid);
    } catch (e: any) {
      this.logger.warn(`getPdf(${uuid}) falló: ${e?.message || e}`);
      return null;
    }
  }
}
