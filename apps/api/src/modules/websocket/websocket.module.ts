import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ReportsGateway, EventsService } from './events.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  providers: [ReportsGateway, EventsService],
  exports: [EventsService],
})
export class WebSocketModule {}