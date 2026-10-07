import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { ReportsGateway, EventsService } from './events.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: requireJwtSecret(),
      signOptions: { expiresIn: '12h', algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  providers: [ReportsGateway, EventsService],
  exports: [EventsService],
})
export class WebSocketModule {}