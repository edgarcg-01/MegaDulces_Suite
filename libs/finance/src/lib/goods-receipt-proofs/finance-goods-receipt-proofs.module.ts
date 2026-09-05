import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule, requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import { GoodsReceiptProofsController } from './goods-receipt-proofs.controller';
import { GoodsReceiptsGateway } from './goods-receipts.gateway';
import { GoodsReceiptsWatcherService } from './goods-receipts-watcher.service';
import { GoodsReceiptTwinsService } from './goods-receipt-twins.service';

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
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [GoodsReceiptProofsController],
  providers: [GoodsReceiptProofsService, GoodsReceiptsGateway, GoodsReceiptsWatcherService, GoodsReceiptTwinsService],
  exports: [GoodsReceiptProofsService],
})
export class FinanceGoodsReceiptProofsModule {}
