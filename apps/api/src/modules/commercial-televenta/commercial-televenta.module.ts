import { Module } from '@nestjs/common';
import { CommercialTeleventaController } from './commercial-televenta.controller';
import { CommercialTeleventaService } from './commercial-televenta.service';
import { TeleventaCronService } from './televenta-cron.service';

/**
 * Fase E — Remote Manager / Televenta.
 *
 * Exposes:
 *   - GET    /api/commercial/televenta/queue
 *   - GET    /api/commercial/televenta/my-reservations
 *   - POST   /api/commercial/televenta/leads/:customer_id/reserve
 *   - POST   /api/commercial/televenta/reservations/:reservation_id/release
 *   - GET    /api/commercial/televenta/customers/:customer_id/snapshot
 *   - GET    /api/commercial/televenta/customers/:customer_id/calls
 *   - POST   /api/commercial/televenta/calls
 *
 * Internal cron @5min libera reservas expiradas (defense-in-depth).
 */
@Module({
  controllers: [CommercialTeleventaController],
  providers: [CommercialTeleventaService, TeleventaCronService],
  exports: [CommercialTeleventaService],
})
export class CommercialTeleventaModule {}
