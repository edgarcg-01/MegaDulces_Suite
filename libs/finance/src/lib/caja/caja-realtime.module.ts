import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions, PgListenService } from '@megadulces/platform-core';
import { CajaGateway } from './caja.gateway';
import { CajaRealtimeService } from './caja-realtime.service';

/**
 * CG.23.2 — Módulo delgado del tiempo real de Caja General. Lo importa
 * `FinanceCajaGeneralModule` para poder empujar `caja_changed` cuando alguien guarda o
 * confirma acá; el puente `NOTIFY → WS` arranca solo con el módulo.
 *
 * Nest lo instancia una vez (módulo singleton) → un único namespace `/caja`. `JwtModule` local
 * para el handshake, con el mismo default que las demás gateways de finanzas.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  providers: [CajaGateway, CajaRealtimeService, PgListenService],
  // `[CG.197]` `PgListenService` se EXPORTA para que el autollenado se cuelgue del MISMO canal
  // con la MISMA conexión. Darle su propia instancia abriría una segunda conexión `LISTEN` a
  // prod para escuchar exactamente lo mismo — y dos oyentes del mismo aviso son dos corridas.
  // `[CG.201]` Y el `JwtModule`: el token del QR de la firma se firma y verifica con el MISMO secreto.
  exports: [CajaGateway, PgListenService, JwtModule],
})
export class CajaRealtimeModule {}
