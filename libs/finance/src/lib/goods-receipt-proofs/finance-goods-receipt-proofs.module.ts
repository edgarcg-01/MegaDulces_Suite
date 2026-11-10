import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule, requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import { GoodsReceiptProofsController } from './goods-receipt-proofs.controller';
import { GoodsReceiptsGateway } from './goods-receipts.gateway';
import { GoodsReceiptsWatcherService } from './goods-receipts-watcher.service';
import { GoodsReceiptTwinsService } from './goods-receipt-twins.service';
import { ReceiptSlaService } from './receipt-sla.service';
import { GoodsReceiptExpedienteService } from './goods-receipt-expediente.service';
import { CajaRealtimeModule } from '../caja/caja-realtime.module';

/**
 * Fase CC (extensión) — Comprobantes de Orden de Entrada. Adjunta la remisión/
 * factura del proveedor (imagen/PDF) + OCR a una orden de entrada de Kepler
 * (X-A-40). Reusa `CloudinaryModule` (adjunto img/PDF) y `AiProductMatcherModule`
 * (que exporta `LlmExtractorService` para el OCR). Lee las entradas del espejo
 * read-only `analytics.erp_goods_receipts`; NO escribe a Kepler.
 *
 * `[RE.69]` ⛔ `CajaRealtimeModule` se IMPORTA por `PgListenService` (el apareo y el aviso de entradas
 * escuchan `caja_fuente`), y NO se provee acá: no es global, y proveerlo abriría una segunda conexión
 * `LISTEN` contra prod. Olvidar el import no falla al compilar: tira el arranque de Nest (`[CB.53.1]`).
 * Lo vigila `finance-goods-receipt-proofs.module.arranque.spec.ts`.
 */
@Module({
  imports: [
    CloudinaryModule,
    AiProductMatcherModule,
    CajaRealtimeModule,
    // JwtModule embebido (mismo default secret que auth-mt) para el handshake del gateway WS.
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [GoodsReceiptProofsController],
  providers: [
    GoodsReceiptProofsService, GoodsReceiptsGateway, GoodsReceiptsWatcherService,
    GoodsReceiptTwinsService,
    // `[RE.27.C]` El reloj de la cola. Los dos plazos ya vivían en
    // `finance.receipt_settings` y ninguno disparaba nada.
    ReceiptSlaService,
    // `[RE.35]` El expediente de la factura (sólo lectura, ADR-085).
    GoodsReceiptExpedienteService,
  ],
  exports: [GoodsReceiptProofsService, ReceiptSlaService],
})
export class FinanceGoodsReceiptProofsModule {}
