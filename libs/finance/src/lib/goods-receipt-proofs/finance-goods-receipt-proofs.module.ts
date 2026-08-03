import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import { GoodsReceiptProofsController } from './goods-receipt-proofs.controller';

/**
 * Fase CC (extensión) — Comprobantes de Orden de Entrada. Adjunta la remisión/
 * factura del proveedor (imagen/PDF) + OCR a una orden de entrada de Kepler
 * (X-A-40). Reusa `CloudinaryModule` (adjunto img/PDF) y `AiProductMatcherModule`
 * (que exporta `LlmExtractorService` para el OCR). Lee las entradas del espejo
 * read-only `analytics.erp_goods_receipts`; NO escribe a Kepler.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule],
  controllers: [GoodsReceiptProofsController],
  providers: [GoodsReceiptProofsService],
  exports: [GoodsReceiptProofsService],
})
export class FinanceGoodsReceiptProofsModule {}
