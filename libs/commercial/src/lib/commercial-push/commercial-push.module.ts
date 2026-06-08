import { Module } from '@nestjs/common';
import { CommercialPushService } from './commercial-push.service';
import { CommercialPushController } from './commercial-push.controller';

@Module({
  controllers: [CommercialPushController],
  providers: [CommercialPushService],
  exports: [CommercialPushService],
})
export class CommercialPushModule {}
