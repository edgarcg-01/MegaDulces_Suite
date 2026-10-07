import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { AlertsGateway } from './alerts.gateway';
import { AlertsService } from './alerts.service';
import { AlertsScannerService } from './alerts-scanner.service';
import { AlertsController } from './alerts.controller';

/**
 * Módulo de alertas comerciales WS realtime.
 *
 * El JwtModule embedded localmente (no importado de auth-mt) para que el
 * gateway pueda decode el token del handshake sin depender del módulo de
 * autenticación. Default secret matched con auth-mt para evitar mismatch.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [AlertsController],
  providers: [AlertsGateway, AlertsService, AlertsScannerService],
  exports: [AlertsService],
})
export class CommercialAlertsModule {}
