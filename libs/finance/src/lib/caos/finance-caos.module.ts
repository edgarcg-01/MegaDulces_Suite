import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions, PgListenService } from '@megadulces/platform-core';
import { CaosService } from './caos.service';
import { CaosController } from './caos.controller';
import { CaosGateway } from './caos.gateway';
import { CaosRealtimeService } from './caos-realtime.service';

/**
 * CS.2 — Módulo de lectura de CAOS (caja fuerte de efectivo): el reporte de movimientos + su
 * tiempo real (namespace `/caos`, puente NOTIFY→WS). La escritura la hace el importer on-prem,
 * no la app.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [CaosController],
  providers: [CaosService, CaosGateway, CaosRealtimeService, PgListenService],
  exports: [CaosService, CaosGateway],
})
export class FinanceCaosModule {}
