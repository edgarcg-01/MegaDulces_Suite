import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BancosGateway } from './bancos.gateway';

/**
 * CB (WS) — Módulo delgado del gateway de Bancos. Lo importan FinanceBankModule
 * (import / sync del Sheet / conciliación) y FinanceBankCaptureModule (comprobantes)
 * para empujar `bancos_changed`. Nest lo instancia una sola vez (módulo singleton) →
 * un único namespace `/bancos`, aunque lo importen dos módulos. JwtModule local para
 * el handshake (mismo default que las demás gateways de finanzas / AlertsGateway).
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  providers: [BancosGateway],
  exports: [BancosGateway],
})
export class BancosRealtimeModule {}
