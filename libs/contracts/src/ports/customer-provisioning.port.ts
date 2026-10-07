// Port de inversión de dependencia: Trade Marketing (stores) provisiona un
// cliente comercial al dar de alta una tienda, SIN importar el dominio commercial.
// Trade inyecta este token con @Optional() (el binding solo existe con
// ENABLE_MULTITENANT=true) y lo llama best-effort post-commit. El binding al
// servicio real se hace en el composition root (app.module), único lugar que
// conoce ambos lados. A diferencia de OrderFulfillmentPort, NO comparte trx:
// el provisioning del cliente no necesita ser atómico con el alta de la tienda.

export const CUSTOMER_PROVISIONING_PORT = 'CUSTOMER_PROVISIONING_PORT';

export interface CustomerProvisioningPort {
  /**
   * Crea (o reusa, idempotente) el cliente comercial vinculado a la tienda.
   * Abre su propia transacción. Lanza si no hay price_list default — el caller
   * lo invoca best-effort y traga el error sin romper el alta de la tienda.
   */
  ensureCustomerForStore(storeId: string): Promise<unknown>;
}
