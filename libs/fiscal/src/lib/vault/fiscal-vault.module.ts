import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { SatCredentialsService } from './sat-credentials.service';
import { SatCredentialsController } from './sat-credentials.controller';

/**
 * FISCAL.2 (libs/fiscal) — Bóveda de credenciales SAT (e.firma/CIEC).
 * Cifrado AES-256-GCM con master key en env (FISCAL_CRYPTO_KEY). Exporta
 * CryptoService + SatCredentialsService para la capa SAT WS (descarga masiva).
 */
@Module({
  controllers: [SatCredentialsController],
  providers: [CryptoService, SatCredentialsService],
  exports: [CryptoService, SatCredentialsService],
})
export class FiscalVaultModule {}
