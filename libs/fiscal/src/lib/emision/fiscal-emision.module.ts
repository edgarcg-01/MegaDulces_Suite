import { Module } from '@nestjs/common';
import { FiscalCfdiModule } from '../cfdi/fiscal-cfdi.module';
import { EmisionService } from './emision.service';
import { EmisionController } from './emision.controller';
import { OrderInvoiceIssuerService } from './order-invoice-issuer.service';
import { SwPacService } from './pac-sw.service';
import { PAC_PORT } from './pac.port';

/**
 * FE.0/FE.2 (libs/fiscal) — Emisión/timbrado de facturas CFDI 4.0.
 * PAC por defecto: SW SmarterWeb (Conectia). Reusa el parser del almacén CFDI
 * para persistir la emitida en fiscal.cfdis (rol=emitidas).
 */
@Module({
  imports: [FiscalCfdiModule],
  controllers: [EmisionController],
  providers: [EmisionService, OrderInvoiceIssuerService, { provide: PAC_PORT, useClass: SwPacService }],
  exports: [EmisionService, OrderInvoiceIssuerService],
})
export class FiscalEmisionModule {}
