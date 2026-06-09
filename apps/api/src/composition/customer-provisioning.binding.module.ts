import { Global, Module } from '@nestjs/common';
import { CUSTOMER_PROVISIONING_PORT } from '@megadulces/contracts';
import { CommercialCustomersModule } from '@megadulces/commercial';
import { CommercialCustomersService } from '@megadulces/commercial';

/**
 * Composition root del Port de provisioning de clientes.
 *
 * Liga CUSTOMER_PROVISIONING_PORT (contracts, inyectado por Trade/StoresService)
 * al servicio concreto de commercial. @Global() para que el token sea resoluble
 * desde StoresModule (que se carga SIEMPRE, incluso sin MT) sin que trade importe
 * commercial. Como StoresService inyecta el token con @Optional(), cuando este
 * binding no se carga (ENABLE_MULTITENANT=false) el hook simplemente no corre.
 */
@Global()
@Module({
  imports: [CommercialCustomersModule],
  providers: [
    { provide: CUSTOMER_PROVISIONING_PORT, useExisting: CommercialCustomersService },
  ],
  exports: [CUSTOMER_PROVISIONING_PORT],
})
export class CustomerProvisioningBindingModule {}
