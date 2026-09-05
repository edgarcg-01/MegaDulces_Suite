import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule, requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { CollectionDepositsService } from './collection-deposits.service';
import { CollectionDepositsController } from './collection-deposits.controller';
import { CobranzaGateway } from './cobranza.gateway';

/**
 * Fase CC — Comprobantes de Cobranza. Adjunta el comprobante de depósito (imagen/PDF)
 * + OCR a un cobro de Kepler (UA0501). Reusa `CloudinaryModule` (adjunto img/PDF) y
 * `AiProductMatcherModule` (que exporta `LlmExtractorService` para el OCR). Lee los
 * cobros del espejo read-only `analytics.erp_collections`; NO escribe a Kepler.
 */
@Module({
  imports: [
    CloudinaryModule,
    AiProductMatcherModule,
    // JwtModule local para el handshake del gateway (mismo default que las otras gateways de Finanzas).
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [CollectionDepositsController],
  providers: [CollectionDepositsService, CobranzaGateway],
  exports: [CollectionDepositsService],
})
export class FinanceCollectionDepositsModule {}
