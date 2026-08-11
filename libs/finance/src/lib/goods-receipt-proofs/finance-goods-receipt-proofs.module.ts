import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import { GoodsReceiptProofsController } from './goods-receipt-proofs.controller';
import { GoodsReceiptsGateway } from './goods-receipts.gateway';
import { GoodsReceiptsWatcherService } from './goods-receipts-watcher.service';

/**
 * Fase CC (extensión) — Comprobantes de Orden de Entrada. Adjunta la remisión/
 * factura del proveedor (imagen/PDF) + OCR a una orden de entrada de Kepler
 * (X-A-40). Reusa `CloudinaryModule` (adjunto img/PDF) y `AiProductMatcherModule`
 * (que exporta `LlmExtractorService` para el OCR). Lee las entradas del espejo
 * read-only `analytics.erp_goods_receipts`; NO escribe a Kepler.
 */
@Module({
  imports: [
    CloudinaryModule,
    AiProductMatcherModule,
    // JwtModule embebido (mismo default secret que auth-mt) para el handshake del gateway WS.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  controllers: [GoodsReceiptProofsController],
  providers: [GoodsReceiptProofsService, GoodsReceiptsGateway, GoodsReceiptsWatcherService],
  exports: [GoodsReceiptProofsService],
})
export class FinanceGoodsReceiptProofsModule {}
