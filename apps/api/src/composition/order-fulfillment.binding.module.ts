import { Global, Module } from '@nestjs/common';
import { ORDER_FULFILLMENT_PORT } from '@megadulces/contracts';
import { CommercialOrdersModule } from '@megadulces/commercial';
import { CommercialOrdersService } from '@megadulces/commercial';

/**
 * Composition root del Port de fulfillment de órdenes.
 *
 * Único lugar que conoce AMBOS lados de la inversión: liga el token
 * ORDER_FULFILLMENT_PORT (declarado en @megadulces/contracts, inyectado por
 * logística) al servicio concreto de commercial. @Global() para que el token
 * sea resoluble desde LogisticsShipmentsModule sin que logística importe commercial.
 *
 * Al extraer logística como servicio aparte: reemplazar el useExisting por un
 * provider que devuelva un cliente HTTP/RPC contra el servicio commercial.
 */
@Global()
@Module({
  imports: [CommercialOrdersModule],
  providers: [
    { provide: ORDER_FULFILLMENT_PORT, useExisting: CommercialOrdersService },
  ],
  exports: [ORDER_FULFILLMENT_PORT],
})
export class OrderFulfillmentBindingModule {}
