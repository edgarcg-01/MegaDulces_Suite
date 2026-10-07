import { Module } from '@nestjs/common';
import { CommercialPushService } from './commercial-push.service';
import { CommercialPushController } from './commercial-push.controller';
import { RouteTicketReminderService } from './route-ticket-reminder.service';

@Module({
  controllers: [CommercialPushController],
  providers: [CommercialPushService, RouteTicketReminderService],
  exports: [CommercialPushService, RouteTicketReminderService],
})
export class CommercialPushModule {}
