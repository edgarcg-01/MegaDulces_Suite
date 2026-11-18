import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule, requireJwtSecret, jwtVerifyOptions, PgListenService } from '@megadulces/platform-core';
import { CollectionDepositsService } from './collection-deposits.service';
import { CollectionDepositsController } from './collection-deposits.controller';
import { CobranzaGateway } from './cobranza.gateway';
import { CobranzaGapScannerService } from './cobranza-gap-scanner.service';
import { CustomerDepositsService } from './customer-deposits.service';
import { FichasAvisoBancoService } from './fichas-aviso-banco.service';
import { CustomerDepositPublicController, CustomerDepositsController } from './customer-deposits.controller';

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
  // [CC.20] El depósito del cliente: su superficie pública (enlace sin sesión) y la bandeja de Cobranza.
  controllers: [CollectionDepositsController, CustomerDepositsController, CustomerDepositPublicController],
  // [CC.21] El aviso de Bancos (bancos_movimientos) refresca la bandeja de fichas. PgListenService NO es global: cada
  // módulo que escucha lo provee (conexión dedicada, sólo se abre si alguien escucha).
  providers: [CollectionDepositsService, CobranzaGateway, CobranzaGapScannerService, CustomerDepositsService, PgListenService, FichasAvisoBancoService],
  exports: [CollectionDepositsService, CustomerDepositsService],
})
export class FinanceCollectionDepositsModule {}
